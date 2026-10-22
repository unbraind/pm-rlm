import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createExtensionCommandSdk } from '@unbrained/pm-cli/sdk';
import { blobDigest, RlmBlobs } from '../src/blobs.ts';
import { RlmLedger } from '../src/ledger.ts';
import { runRlm, replayRlm, resumeRlm } from '../src/engine.ts';
import { testEnvironment } from '../scripts/environment.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Build a real completed run for storage-format and corruption checks. */
async function fixture(t: Parameters<typeof tracker>[0]) {
  const setup = await tracker(t);
  await setup.client.create({ id: 'source-item', title: 'Immutable public fixture', description: 'large public fixture '.repeat(1000) });
  const model = new ScriptedModel((_request, index) => index === 0 ? '{"action":"count"}' : '{"action":"finish","answer":"1"}');
  const result = await runRlm('count source items', { workspace: setup.workspace, model });
  const ledger = new RlmLedger(setup.workspace);
  const raw = String((await setup.client.listAllComplete({ includeBody: true })).items.find(item => item.id === result.run)!.rlm_state);
  return { ...setup, model, result, ledger, raw, manifest: JSON.parse(raw) as Record<string, unknown> };
}

/** Snapshots and unchanged prompt payloads deduplicate; no source strings enter root history. */
test('content addressed manifests deduplicate snapshots and transcript payloads', async t => {
  const { workspace, client, result, ledger, raw, manifest, model } = await fixture(t);
  assert.equal(manifest.version, 2);
  assert.ok(raw.length < 400);
  assert.ok(!raw.includes('large public fixture'));
  const state = await ledger.load(result.run);
  assert.equal(state.reserved_tokens, result.reserved_tokens);
  const directory = join(workspace, 'rlm-blobs');
  const before = await readdir(directory);
  const snapshotPath = join(directory, `${String(manifest.snapshot)}.json`);
  const snapshotBefore = await stat(snapshotPath, { bigint: true });
  await ledger.save(state);
  assert.deepEqual(await readdir(directory), before);
  const snapshotAfter = await stat(snapshotPath, { bigint: true });
  assert.equal(snapshotAfter.ino, snapshotBefore.ino);
  assert.equal(snapshotAfter.mtimeNs, snapshotBefore.mtimeNs);
  const next = structuredClone(state); next.run = 'another-run'; next.calls[0].id = next.run;
  await ledger.materialize(next, next.calls[0]);
  const other = JSON.parse(String((await client.get(next.run, { depth: 'full' })).item.rlm_state)) as Record<string, unknown>;
  assert.equal(manifest.snapshot, other.snapshot);
  const history = await readFile(join(workspace, 'history', `${result.run}.jsonl`), 'utf8');
  assert.ok(!history.includes('large public fixture'));
  assert.equal((await replayRlm(workspace, result.run)).answer, '1');
  assert.equal((await resumeRlm(workspace, result.run, model)).reserved_tokens, result.reserved_tokens);
});

/** Reads and replay of v1 are observational, while saving migrates only the active root. */
test('legacy checkpoints read unchanged and migrate lazily without rewriting history', async t => {
  const { workspace, client, ledger, result, model } = await fixture(t);
  const state = await ledger.load(result.run);
  const legacy = JSON.stringify(state);
  await client.run('update', { id: result.run, options: { rlmState: legacy } });
  const historyPath = join(workspace, 'history', `${result.run}.jsonl`);
  const history = await readFile(historyPath, 'utf8');
  assert.deepEqual(await ledger.load(result.run), state);
  assert.equal((await replayRlm(workspace, result.run)).answer, '1');
  assert.equal((await client.listAllComplete({ includeBody: true })).items.find(item => item.id === result.run)!.rlm_state, legacy);
  assert.equal(await readFile(historyPath, 'utf8'), history);
  await ledger.save(await ledger.load(result.run));
  await resumeRlm(workspace, result.run, model);
  assert.equal(JSON.parse(String((await client.get(result.run, { depth: 'full' })).item.rlm_state)).version, 2);
  assert.ok((await readFile(historyPath, 'utf8')).startsWith(history));
});

/** Hashes, paths and referenced shape validation all fail closed before model construction. */
test('blob reads refuse tampering missing payloads invalid digests and malformed transcript graphs', async t => {
  const { workspace, ledger, result, manifest, client } = await fixture(t);
  const path = join(workspace, 'rlm-blobs', `${String(manifest.snapshot)}.json`);
  const original = await readFile(path, 'utf8');
  await writeFile(path, original.replace('Immutable', 'Corrupted'));
  await assert.rejects(ledger.load(result.run), { code: 'incomplete' });
  await assert.rejects(ledger.gc(), { code: 'incomplete' });
  await assert.rejects(new RlmBlobs(workspace).put(JSON.parse(original)), { code: 'incomplete' });
  await rm(path);
  await assert.rejects(ledger.load(result.run), { code: 'incomplete' });
  await writeFile(path, original);
  const blobs = new RlmBlobs(workspace);
  const transcript = await blobs.get(manifest.transcript) as Record<string, unknown>;
  const call = await blobs.get((transcript.calls as string[])[0]) as Record<string, unknown>;
  const malformed = [
    { ...manifest, snapshot: '../escape' }, { ...manifest, snapshot: 1 },
    { ...manifest, transcript: await blobs.put({ ...transcript, version: 3 }) },
    { ...manifest, transcript: await blobs.put({ ...transcript, run: 'wrong' }) },
    { ...manifest, transcript: await blobs.put({ ...transcript, calls: null }) },
    { ...manifest, transcript: await blobs.put({ ...transcript, calls: [await blobs.put({ ...call, steps: null })] }) },
  ];
  for (const value of malformed) {
    await client.run('update', { id: result.run, options: { rlmState: JSON.stringify(value) } });
    await assert.rejects(ledger.load(result.run), { code: 'incomplete' });
  }
  const invalid = '{'; const digest = blobDigest(invalid);
  await writeFile(join(workspace, 'rlm-blobs', `${digest}.json`), invalid);
  await assert.rejects(blobs.get(digest), SyntaxError);
});

/** Reachability includes old manifest revisions, so audit evidence survives collection. */
test('GC removes orphans and abandoned partial files but retains verified historical references', async t => {
  const { workspace, ledger, result } = await fixture(t);
  const state = await ledger.load(result.run);
  const original = state.calls[0].steps[0].prompt;
  state.calls[0].steps[0].prompt = 'replacement prompt';
  await ledger.save(state);
  const blobs = new RlmBlobs(workspace);
  const orphan = await blobs.put('unreachable payload');
  const directory = join(workspace, 'rlm-blobs');
  const temporary = `.${orphan}.json.123.456.abcdef.tmp`;
  await writeFile(join(directory, temporary), Buffer.from([112, 97, 114, 116, 105, 97, 255]));
  await writeFile(join(directory, 'unrelated.txt'), 'preserve');
  await writeFile(join(workspace, 'history', 'readme.txt'), 'preserve');
  const collected = await ledger.gc();
  assert.equal(collected.removed, 2);
  await assert.rejects(readFile(join(directory, `${orphan}.json`)), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, temporary)), { code: 'ENOENT' });
  assert.equal(collected.bytes, Buffer.byteLength(JSON.stringify('unreachable payload')) + 7);
  assert.ok((await readdir(directory)).includes(`${blobDigest(JSON.stringify(original))}.json`));
  assert.equal((await ledger.load(result.run)).calls[0].steps[0].prompt, 'replacement prompt');
  assert.equal((await ledger.gc()).removed, 0);
  await writeFile(join(workspace, 'history', 'broken.jsonl'), 'invalid');
  await assert.rejects(ledger.gc(), { code: 'incomplete' });
  await rm(join(workspace, 'history', 'broken.jsonl'));
  const historyPath = join(workspace, 'history', `${result.run}.jsonl`);
  const lines = (await readFile(historyPath, 'utf8')).trim().split('\n');
  const last = JSON.parse(lines.at(-1)!); last.after_hash = '0'.repeat(64);
  lines[lines.length - 1] = JSON.stringify(last);
  await writeFile(historyPath, lines.join('\n') + '\n');
  await assert.rejects(ledger.gc(), { code: 'incomplete' });
});

/** Empty stores collect cleanly; filesystem failures are sanitized rather than exposed. */
test('GC empty store and unreadable blob directory are handled explicitly', async t => {
  const { workspace } = await tracker(t);
  const ledger = new RlmLedger(workspace);
  assert.deepEqual(await ledger.gc(), { removed: 0, bytes: 0 });
  const directory = join(workspace, 'rlm-blobs');
  await writeFile(directory, 'a file');
  await assert.rejects(ledger.gc(), { code: 'incomplete' });
  await rm(directory); await mkdir(directory);
  await symlink(join(workspace, 'missing-target'), join(directory, `${'b'.repeat(64)}.json`));
  assert.deepEqual(await ledger.gc(), { removed: 1, bytes: 0 });
  await mkdir(join(directory, `${'a'.repeat(64)}.json`));
  await assert.rejects(ledger.gc(), { code: 'incomplete' });
  await rm(join(workspace, 'locks'), { recursive: true, force: true });
  await writeFile(join(workspace, 'locks'), 'not a directory');
  await assert.rejects(ledger.gc(), { name: 'PmCliError' });
});

/** Child runs with no git executable and a discovery ceiling, using only the real SDK. */
test('storage run resume replay and GC work in a non-git tracker with no git on PATH', async t => {
  const { workspace, root } = await tracker(t);
  const child = fork(join(import.meta.dirname, 'ledger-storage-worker.ts'), [workspace, 'no-git'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...testEnvironment(process.env), PATH: root, GIT_CEILING_DIRECTORIES: dirname(root) } });
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit');
  const [reply] = await Promise.race([once(child, 'message'), exited.then(() => [null])]);
  const [code] = await exited;
  assert.equal(code, 0); assert.deepEqual(reply, { answer: 'without git' });
});

/** Confirm Linux has stopped the writer before inspecting its actual pending atomic write. */
async function waitForStoppedWriter(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (/^State:\s+T/m.test(await readFile(join('/proc', String(pid), 'status'), 'utf8'))) return;
    await new Promise(resolve => { setTimeout(resolve, 5); });
  }
  assert.fail('Writer did not enter the stopped state');
}

/** Kill only a confirmed partial native write; queued events after publication are not crash evidence. */
for (const mode of ['blob', 'root']) test(`SIGKILL during ${mode} write leaves the previous budget and transcript intact`, { skip: process.platform !== 'linux' && 'requires /proc and SIGSTOP' }, async t => {
  const { workspace, client, ledger, result, model } = await fixture(t);
  const sdk = createExtensionCommandSdk(workspace, client, 'storage-crash-fixture');
  await sdk.mutateWorkspaceSettings({ operationId: 'crash-fixture-lock-policy', mutate: current => ({ ...current, locks: { ...current.locks, ttl_seconds: 1 }, governance: { ...current.governance, force_required_for_stale_lock: false } }) });
  const before = await ledger.load(result.run);
  const writeBytes = 32 * 1024 * 1024;
  // The digest manifest is deliberately tiny. Pad an unrelated item field to widen real root I/O.
  if (mode === 'root') await client.run('update', { id: result.run, options: { description: 'x'.repeat(writeBytes) } });
  const rootPath = join(workspace, 'tasks', `${result.run}.toon`);
  let killed = false;
  for (let attempt = 0; attempt < 8 && !killed; attempt++) {
    await ledger.save(before);
    const originalRow = await readFile(rootPath);
    const child = fork(join(import.meta.dirname, 'ledger-storage-worker.ts'), [workspace, mode, result.run, String(attempt)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: testEnvironment(process.env) });
    t.after(() => child.kill('SIGKILL'));
    const exit = once(child, 'exit');
    const [message] = await Promise.race([once(child, 'message'), exit.then(() => [null])]) as [{ temporary?: string; missed?: boolean } | null];
    if (message === null || message.missed === true) { assert.equal((await exit)[0], 0); continue; }
    assert.ok(message.temporary); assert.match(message.temporary, /\.tmp$/);
    await waitForStoppedWriter(child.pid!);
    const temporary = await stat(join(workspace, mode === 'blob' ? 'rlm-blobs' : 'tasks', message.temporary)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (temporary === null || temporary.size === 0 || temporary.size >= writeBytes) {
      child.kill('SIGCONT'); assert.equal((await exit)[0], 0); continue;
    }
    assert.ok((await readFile(rootPath)).equals(originalRow), 'Root must remain unpublished while the actual temporary file is partial');
    t.diagnostic(`${mode}: stopped writer with ${temporary.size} bytes of an incomplete write; root unchanged before SIGKILL`);
    child.kill('SIGKILL'); assert.deepEqual(await exit, [null, 'SIGKILL']); killed = true;
  }
  assert.ok(killed, 'A real stopped partial write must be killed; missed windows cannot satisfy the drill');
  assert.deepEqual(await ledger.load(result.run), before);
  // The real SDK item lock uses the fixture's short TTL and automatic stale recovery policy.
  if (mode === 'root') await new Promise(resolve => { setTimeout(resolve, 1100); });
  assert.equal((await resumeRlm(workspace, result.run, model)).reserved_tokens, before.reserved_tokens);
  assert.equal((await replayRlm(workspace, result.run)).answer, '1');
  await ledger.gc();
});

/** A live collector cannot race publication; waiting collectors recover only after that owner releases. */
test('storage lease serializes collectors and bounds busy waits', async t => {
  const { workspace } = await tracker(t);
  const ledger = new RlmLedger(workspace);
  const release = await ledger.lease('__blob_store');
  const collecting = ledger.gc();
  await new Promise(resolve => { setTimeout(resolve, 100); });
  await release();
  assert.equal((await collecting).removed, 0);
  const releaseAgain = await ledger.lease('__blob_store');
  const realNow = Date.now(); let clock = realNow;
  t.mock.method(Date, 'now', () => { clock += 60001; return clock; });
  await assert.rejects(ledger.gc(), { code: 'busy' });
  t.mock.restoreAll(); await releaseAgain();
  await writeFile(join(workspace, 'runtime', 'rlm-__blob_store.json'), '{');
  await assert.rejects(ledger.gc(), { code: 'incomplete' });
});

/** Immutable historical reachability permits hydration without runtime lease-file writes. */
test('load and replay preserve lease-free reads of new and legacy checkpoints', async t => {
  const { workspace, ledger, result, client } = await fixture(t);
  const state = await ledger.load(result.run);
  for (const raw of [undefined, JSON.stringify(state)]) {
    if (raw !== undefined) await client.run('update', { id: result.run, options: { rlmState: raw } });
    const directory = join(workspace, 'runtime');
    await mkdir(directory, { recursive: true });
    const events: string[] = [];
    const watcher = watch(directory, (_event, name) => { if (name?.includes('rlm-')) events.push(name); });
    try {
      await assert.doesNotReject(async () => {
        assert.deepEqual(await ledger.load(result.run), state);
        assert.equal((await replayRlm(workspace, result.run)).answer, '1');
      });
      await new Promise<void>(resolve => { setImmediate(resolve); });
      assert.deepEqual(events, []);
    } finally { watcher.close(); }
  }
});

/** Unknown schemas may carry unrecognized references, so GC must preserve all data and refuse. */
test('GC refuses unknown storage versions before removing future payloads', async t => {
  const { workspace, client } = await tracker(t);
  const ledger = new RlmLedger(workspace);
  await ledger.registerFields();
  const reference = await new RlmBlobs(workspace).put('future payload');
  await client.run('create', { options: { id: 'future-run', title: 'Future storage fixture', rlmState: JSON.stringify({ version: 3, payload: reference }) } });
  await assert.rejects(ledger.gc(), { code: 'incomplete' });
  assert.equal(await readFile(join(workspace, 'rlm-blobs', `${reference}.json`), 'utf8'), JSON.stringify('future payload'));
});

/** Identical content references must not introduce aliases between independently mutable logical steps. */
test('hydrated transcript payloads preserve independent JSON values', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Count fixture' });
  let step = 0;
  const result = await runRlm('repeat count', { workspace, model: {
    name: 'identical-payload-test-only',
    complete: async () => ({ text: JSON.stringify(step++ < 2 ? { action: 'count' } : { action: 'finish', answer: '1' }), tokens_in: 20, tokens_out: 10 }),
  } });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(result.run);
  const [first, second] = state.calls[0].steps;
  assert.deepEqual(first.response, second.response);
  assert.deepEqual(first.observation, second.observation);
  assert.notStrictEqual(first.response, second.response);
  assert.notStrictEqual(first.observation, second.observation);
  first.response!.tokens_in = 999;
  (first.observation as { data: number }).data = 999;
  assert.equal(second.response!.tokens_in, 20);
  assert.equal((second.observation as { data: number }).data, 1);
  assert.equal((await ledger.load(result.run)).calls[0].steps[0].response!.tokens_in, 20);
  assert.equal((await replayRlm(workspace, result.run)).answer, '1');
});

/** Raw-byte hashing must detect damage that permissive UTF-8 decoding would normalize away. */
test('raw UTF-8 integrity refuses normalized corruption in reads and reuse', async t => {
  const { workspace } = await tracker(t);
  const blobs = new RlmBlobs(workspace);
  const value = { description: 'replacement \uFFFD' };
  const reference = await blobs.put(value);
  const path = join(workspace, 'rlm-blobs', `${reference}.json`);
  const original = await readFile(path);
  const offset = original.indexOf(Buffer.from('\uFFFD'));
  assert.ok(offset >= 0);
  const corrupt = Buffer.concat([original.subarray(0, offset), Buffer.from([0xff]), original.subarray(offset + 3)]);
  assert.equal(corrupt.toString('utf8'), original.toString('utf8'));
  await writeFile(path, corrupt);
  await assert.rejects(blobs.get(reference), { code: 'incomplete' });
  await assert.rejects(new RlmBlobs(workspace).put(value), { code: 'incomplete' });
  const invalidReference = blobDigest(corrupt);
  assert.notEqual(invalidReference, reference);
  await writeFile(join(workspace, 'rlm-blobs', `${invalidReference}.json`), corrupt);
  await assert.rejects(new RlmBlobs(workspace).get(invalidReference), TypeError);
});
