import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { PmClient, readSettings, resolveRuntimeStatusRegistry } from '@unbrained/pm-cli/sdk';
import { RlmBlobs } from '../src/blobs.ts';
import { readCorpus } from '../src/environment.ts';
import { RlmError } from '../src/errors.ts';
import { prepareRlmRun, replayRlm, resumeRlm, runRlm } from '../src/engine.ts';
import { RlmLedger, promptDigest } from '../src/ledger.ts';
import { compactReuseResult, reuseRlm, validateReuseState } from '../src/reuse.ts';
import { parseReuseRequest, parseReuseProvenance, parseReuseSelection } from '../src/reuse-contract.ts';
import type { RlmReuseOptions } from '../src/reuse.ts';
import type { RlmState, RlmCall } from '../src/types.ts';
import { tracker, ScriptedModel } from './helpers.ts';
import { replaceCheckpointFixture } from './checkpoint-fixture.ts';

const identity = { tool_policy: 'snapshot-v1', model_policy: 'fixture-v1', consent: 'public:1' };
const finish = '{"action":"finish","answer":"answer"}';

/** Fixed seed, portable unsigned arithmetic and no dependence on platform randomness. */
function random(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
}

/** Model checkpoint interchange as exact SDK values; no handwritten normalization oracle. */
test('500 seeded operation sequences preserve SDK-read native fields relationships and older input replays', async t => {
  const { workspace, client } = await tracker(t);
  const parent = (await client.create({ type: 'Task', title: 'Parent' })).item.id;
  const dependency = (await client.create({ type: 'Issue', title: 'Dependency' })).item.id;
  const alternateParent = (await client.create({ type: 'Task', title: 'Alternate parent' })).item.id;
  const source = (await client.create({ type: 'Task', title: 'Native source', parent, tags: 'fixture,source', priority: 1, description: 'line one\r\n  line two  ', body: 'body\r\n exact  bytes' })).item.id;
  await client.update(source, { dep: [`id=${dependency},kind=related`] });
  await client.comments(source, { add: ' comment\r\n text ' });
  const prepared = await prepareRlmRun('checkpoint model', { workspace, reuse_identity: identity, model: new ScriptedModel(() => finish) });
  const ledger = prepared.ledger;
  const release = await ledger.lease(prepared.run);
  const next = random(0x5eeda11);
  try {
    let actual = await ledger.load(prepared.run);
    const nativeReference = (await client.get(prepared.run, { depth: 'full' })).item;
    const inputs: RlmState[] = [];
    for (let revision = 0; revision < 8; revision++) {
      await client.update(source, { title: `Title ${revision}  `, description: ['line\r\n two ', ' line\n two', '  white space  ', 'tab\tvalue'][revision % 4], priority: revision % 4, addTags: [`revision:${revision}`], parent: revision % 2 === 0 ? parent : alternateParent, replaceDeps: true, dep: [`id=${dependency},kind=related`, ...(revision % 2 === 0 ? [] : [`id=${parent},kind=related`])] });
      if (revision % 2 === 0) await client.claim(source); else await client.release(source);
      const snapshot = (await readCorpus(workspace)).items;
      inputs.push({ ...structuredClone(actual), snapshot });
    }
    const blobs = new RlmBlobs(workspace);
    for (let sequence = 0; sequence < 500; sequence++) {
      // Each sequence captures, exports, replays an arbitrary older input, then imports via SDK CAS.
      const captured = structuredClone(inputs[next() % inputs.length]);
      const exported = await blobs.encode(captured);
      const replayed = structuredClone(inputs[next() % inputs.length]);
      const oldExport = await blobs.encode(replayed);
      const selected = next() % 2 === 0 ? exported : oldExport;
      const reference = selected === exported ? captured : replayed;
      const interchange = next() % 3 === 0 ? JSON.stringify(reference) : selected;
      const imported = await blobs.decode(interchange);
      Object.assign(actual, imported);
      await ledger.save(actual);
      actual = await new RlmLedger(workspace).load(prepared.run);
      assert.deepEqual(actual, reference, `seed=0x5eeda11 sequence=${sequence}`);
      // A fresh SDK client must see the same full native source as the captured oracle.
      assert.ok(actual.snapshot.find(item => item.id === source)!.dependencies!.some(edge => edge.id === dependency));
      assert.equal(actual.snapshot.find(item => item.id === source)!.parent, reference.snapshot.find(item => item.id === source)!.parent);
      if (sequence % 25 === 0) {
        const native = (await client.get(prepared.run, { depth: 'full' })).item;
        for (const field of ['id', 'title', 'type', 'status', 'tags', 'parent', 'description', 'body', 'assignee', 'rlm_run', 'rlm_model', 'rlm_depth', 'rlm_prompt_digest', 'rlm_tokens_in', 'rlm_tokens_out']) assert.deepEqual(native[field], nativeReference[field], `native ${field} sequence ${sequence}`);
      }
      // Reacquire write authority by reading through the lease-owning ledger.
      actual = await ledger.load(prepared.run);
    }
    const sourceAfter = (await new PmClient({ pmRoot: workspace, noExtensions: true }).get(source, { depth: 'full' })).item;
    assert.deepEqual(sourceAfter, (await client.get(source, { depth: 'full' })).item);
  } finally { await release(); }
});

/** Every asynchronous publication boundary competes on one real non-git tracker. */
test('reuse interleavings exclude competing source and target transitions at every package step', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'source', tags: 'source', type: 'Issue' });
  const model = new ScriptedModel(() => finish);
  const source = await runRlm('question', { workspace, scope: { tag: 'source' }, reuse_identity: identity, model });
  const origin = await new RlmLedger(workspace).load(source.run);
  const options: RlmReuseOptions = { workspace, scope: origin.scope, settings: origin.settings, reuse_identity: identity, selection: { run: source.run, call: source.run } };
  /** Trace every package await boundary, then inject a peer transition at each occurrence. */
  const execute = async (chosen = -1): Promise<string[]> => {
    const trace: string[] = [];
    const owned = new Set<string>();
    const peer = { running: false };
    let injected = 0;
    const lease = RlmLedger.prototype.lease;
    const load = RlmLedger.prototype.load;
    const save = RlmLedger.prototype.save;
    const materialize = RlmLedger.prototype.materialize;
    const complete = RlmLedger.prototype.complete;
    /** Compete with the real SDK lease at exactly one observed boundary. */
    const boundary = async (name: string, run: string): Promise<void> => {
      const label = run === source.run ? 'source' : run === '__blob_store' ? 'storage' : 'target';
      trace.push(`${label}:${name}`);
      if (trace.length - 1 !== chosen) return;
      injected++;
      Object.assign(peer, { running: true });
      try {
        if (owned.has(run)) await assert.rejects(new RlmLedger(workspace).lease(run), { code: 'busy' });
        else { const release = await new RlmLedger(workspace).lease(run); await release(); }
      } finally { Object.assign(peer, { running: false }); }
    };
    t.mock.method(RlmLedger.prototype, 'lease', async function (this: RlmLedger, run: string) {
      if (peer.running) return lease.call(this, run);
      await boundary('lease:before', run);
      const release = await lease.call(this, run); owned.add(run);
      await boundary('lease:after', run);
      return async () => {
        await boundary('unlock:before', run);
        await release(); owned.delete(run);
        await boundary('unlock:after', run);
      };
    });
    t.mock.method(RlmLedger.prototype, 'load', async function (this: RlmLedger, run: string) {
      await boundary('load:before', run); const state = await load.call(this, run); await boundary('load:after', run); return state;
    });
    t.mock.method(RlmLedger.prototype, 'save', async function (this: RlmLedger, state: RlmState) {
      await boundary('save:before', state.run); await save.call(this, state); await boundary('save:after', state.run);
    });
    t.mock.method(RlmLedger.prototype, 'materialize', async function (this: RlmLedger, state: RlmState, call: RlmCall) {
      await boundary('materialize:before', state.run); await materialize.call(this, state, call); await boundary('materialize:after', state.run);
    });
    t.mock.method(RlmLedger.prototype, 'complete', async function (this: RlmLedger, state: RlmState, call: RlmCall) {
      await boundary('complete:before', state.run); await complete.call(this, state, call); await boundary('complete:after', state.run);
    });
    try {
      const reused = await reuseRlm('question', options);
      assert.equal(reused.status, 'reused');
      assert.equal(model.requests.length, 1);
      if (chosen >= 0) assert.equal(injected, 1);
      return trace;
    } finally { t.mock.restoreAll(); }
  };
  const trace = await execute();
  t.diagnostic(`Competing transitions at all ${trace.length} traced lease/read/publication/completion/release boundaries`);
  for (let index = 0; index < trace.length; index++) await t.test(`${index}:${trace[index]}`, async () => {
    assert.deepEqual(await execute(index), trace);
  });
});

/** Tampering with persisted reuse must refuse on both recovery and replay. */
test('reuse authenticates target invariants provenance answers and original revisions', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel(() => finish);
  const original = await runRlm('question', { workspace, reuse_identity: identity, model });
  const ledger = new RlmLedger(workspace);
  const source = await ledger.load(original.run);
  const options: RlmReuseOptions = { workspace, settings: source.settings, reuse_identity: identity, selection: { run: source.run, call: source.run } };
  const reused = await reuseRlm('question', options);
  assert.equal(reused.status, 'reused'); if (reused.status !== 'reused') return assert.fail();
  const valid = await ledger.load(reused.run);
  for (const alter of [
    (state: RlmState) => { state.reserved_tokens = 1; },
    (state: RlmState) => { state.calls.push(structuredClone(state.calls[0])); },
    (state: RlmState) => { state.calls[0].steps.push({ prompt: 'x', reserved: 1 }); },
    (state: RlmState) => { state.calls[0].failure = { code: 'invalid' }; },
    (state: RlmState) => { delete state.snapshot_only; },
    (state: RlmState) => { state.calls[0].result = 'altered'; },
    (state: RlmState) => { state.reuse!.tokens_in++; },
    (state: RlmState) => { delete state.reuse_identity; },
    (state: RlmState) => { state.parser_version = 2; },
  ]) {
    const bad = structuredClone(valid); alter(bad);
    await assert.rejects(validateReuseState(workspace, bad));
  }
  await assert.rejects(reuseRlm('question', { ...options, selection: { run: reused.run, call: reused.run } }), { dimension: 'original_opt_in' });
  source.calls[0].completion_refusal = { code: 'model', reason: 'hook failed' };
  await replaceCheckpointFixture(ledger, source);
  await assert.rejects(replayRlm(workspace, reused.run), { dimension: 'completion' });
  delete source.calls[0].completion_refusal;
  source.reserved_tokens++;
  await replaceCheckpointFixture(ledger, source);
  await assert.rejects(resumeRlm(workspace, reused.run, model), { dimension: 'provenance' });
  for (const value of [undefined, {}, { ...valid.reuse, state_digest: 'bad' }]) assert.throws(() => parseReuseProvenance(value));
  assert.deepEqual(parseReuseSelection(options.selection), options.selection);
  assert.equal(compactReuseResult({ ...reused, answer: 'x'.repeat(1000) }).answer_complete, false);
  assert.equal(compactReuseResult({ status: 'skipped', reason: 'foreign', remedy: 'select' }).status, 'skipped');
  for (const scope of [{ ids: new Array(2) }, { ids: Object.assign(new Array(3), { 0: 'ok', 2: 'bad' }) }, { ids: Array.from({ length: 10001 }, () => 'x') }, { ids: [NaN] }, { unknown: true }]) assert.throws(() => parseReuseRequest({ question: 'question', identity, selection: options.selection, scope }));
  for (const question of ['', '   ', 'x'.repeat(4097), Infinity, null]) assert.throws(() => parseReuseRequest({ question, identity, selection: options.selection, scope: {} }));
  assert.deepEqual(parseReuseRequest({ question: 'question', identity, selection: options.selection, scope: { ids: ['id'] } }).scope, { ids: ['id'] });
});

/** Arbitrary configured status names retain SDK role semantics during completion recovery. */
test('seeded custom status registries preserve terminal roles instead of comparing status names', async t => {
  const { workspace, client } = await tracker(t);
  const next = random(0x51a7);
  const variants = [
    ['active'], ['blocked'], ['terminal', 'terminal_done'], ['terminal', 'terminal_canceled'], ['terminal'],
  ];
  const model = new ScriptedModel(() => finish);
  const run = await runRlm('question', { workspace, model, reuse_identity: identity });
  for (let index = 0; index < 15; index++) {
    const status = `custom_${next().toString(36)}`;
    const roles = variants[next() % variants.length];
    await client.schemaAddStatus(status, { role: roles });
    const registry = resolveRuntimeStatusRegistry((await readSettings(workspace)).schema);
    await client.run('update', { id: run.run, options: { status, closeReason: 'Role fixture', rlmTokensIn: 123 } });
    await resumeRlm(workspace, run.run, model);
    const row = (await client.get(run.run, { depth: 'full' })).item;
    if (registry.terminal_statuses.has(status)) { assert.equal(row.status, status); assert.equal(row.rlm_tokens_in, 123); }
    else { assert.equal(row.status, registry.close_status); assert.notEqual(row.rlm_tokens_in, 123); }
  }
});

/** A peer may finish or start a newly allocated target between creation and the next acquisition. */
test('reuse reports peer success and refuses started targets without replacing their work', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel(() => finish);
  const run = await runRlm('question', { workspace, model, reuse_identity: identity });
  const source = await new RlmLedger(workspace).load(run.run);
  const options = { workspace, settings: source.settings, reuse_identity: identity, selection: { run: run.run, call: run.run } };
  for (const mode of ['complete', 'started']) {
    const lease = RlmLedger.prototype.lease;
    let injected = 0;
    let target = '';
    t.mock.method(RlmLedger.prototype, 'lease', async function (this: RlmLedger, id: string) {
      const unlock = await lease.call(this, id);
      if (id !== run.run && id !== '__blob_store') target = id;
      if (id !== run.run || injected !== 0) return unlock;
      return async () => {
        await unlock();
        if (injected !== 0 || target === '') return;
        injected++;
        const ledger = new RlmLedger(workspace);
        const release = await lease.call(ledger, target);
        try {
          const state = await ledger.load(target);
          if (mode === 'complete') delete state.reuse_selection;
          else {
            state.calls[0].steps.push({ prompt: 'pending peer prompt', reserved: 1 });
            state.reserved_tokens = 1;
          }
          await ledger.save(state);
        } finally { await release(); }
        if (mode === 'complete') {
          await resumeRlm(workspace, target, model);
          const restore = await lease.call(ledger, target);
          try { const completed = await ledger.load(target); completed.reuse_selection = options.selection; await ledger.save(completed); }
          finally { await restore(); }
        }
      };
    });
    try {
      if (mode === 'complete') {
        const result = await reuseRlm('question', options);
        assert.equal(result.status, 'peer_completed');
        if (result.status === 'peer_completed') assert.ok(result.tokens_in > 0);
      } else await assert.rejects(reuseRlm('question', options), { dimension: 'target_started' });
      assert.equal(injected, 1);
    } finally { t.mock.restoreAll(); }
  }
});

/** Recovery always revalidates durable intent and never turns an interrupted reuse into paid inference. */
test('pending reuse recovery revalidates changed sources and model-free matching checkpoints', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'source', tags: 'source', type: 'Issue' })).item.id;
  const model = new ScriptedModel(() => finish);
  const source = await runRlm('question', { workspace, scope: { tag: 'source' }, model, reuse_identity: identity });
  const origin = await new RlmLedger(workspace).load(source.run);
  const options = { workspace, settings: origin.settings, scope: origin.scope, reuse_identity: identity, reuse_selection: { run: source.run, call: source.run } };
  const pending = await prepareRlmRun('question', options);
  await assert.rejects(prepareRlmRun('question', { ...options, scope: undefined, reuse_identity: undefined }), { dimension: 'request' });
  const result = await resumeRlm(workspace, pending.run, model);
  assert.equal(result.answer, 'answer'); assert.equal(result.tokens_in, 0); assert.equal(model.requests.length, 1);
  const stale = await prepareRlmRun('question', options);
  await client.update(id, { description: 'new revision' });
  await assert.rejects(resumeRlm(workspace, stale.run, model), { dimension: 'snapshot' });
  const untouched = await new RlmLedger(workspace).load(stale.run);
  assert.equal(untouched.calls[0].steps.length, 0); assert.equal(untouched.reuse, undefined);
  assert.equal(model.requests.length, 1);
  await assert.rejects(prepareRlmRun('question', { ...options, source_workspace: workspace }), { dimension: 'source_workspace' });
});

/** Provenance retains pending failed-child charges and sanitizes operational failures. */
test('reuse preserves failed-child accounting and typed operational remedies', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel(request => {
    const input: { question: string; transcript: unknown[] } = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
    if (input.question === 'nested') throw new RlmError('model', 'fixture stopped');
    return input.transcript.length === 0 ? JSON.stringify({ action: 'spawn', subgoal: 'nested', slice: { fragments: [], estimated_tokens: 2 } }) : finish;
  });
  const run = await runRlm('question', { workspace, model, reuse_identity: identity });
  const ledger = new RlmLedger(workspace);
  const origin = await ledger.load(run.run);
  delete origin.calls[0].parent;
  await replaceCheckpointFixture(ledger, origin);
  const options = { workspace, settings: origin.settings, reuse_identity: identity, selection: { run: run.run, call: run.run } };
  const reused = await reuseRlm('question', options);
  assert.equal(reused.status, 'reused');
  if (reused.status === 'reused') { assert.equal(reused.tokens_in, 0); assert.ok(reused.reuse!.reserved_tokens > reused.reuse!.tokens_in + reused.reuse!.tokens_out); }
  const unlock = await ledger.lease(run.run);
  try { await assert.rejects(reuseRlm('question', options), { code: 'busy', dimension: 'tracker' }); } finally { await unlock(); }
  const hostile = Object.defineProperty({ ...identity }, 'consent', { enumerable: true, get() { throw new Error('untrusted detail'); } });
  await assert.rejects(reuseRlm('question', { ...options, reuse_identity: hostile }), { code: 'incomplete', dimension: 'tracker' });
});

/** Suspend real filesystem reads to expose the stale-unlock deletion race deterministically. */
test('duplicate release callbacks cannot delete a newer peer lease after reading old ownership', { timeout: 30000 }, async t => {
  const { workspace } = await tracker(t);
  const path = `${workspace}/runtime/rlm-release-race.json`;
  const ledger = new RlmLedger(workspace);
  const unlock = await ledger.lease('release-race');
  const read = fs.readFile;
  const open = fs.open;
  /** Coordinate actual I/O completions without timing-based sleeps. */
  const signal = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const captured = signal();
  const continueRead = signal();
  const blocked = signal();
  let held = false;
  /** Execute the real read, pausing only after old ownership bytes have been captured. */
  const interceptedRead = async (...args: Parameters<typeof fs.readFile>) => {
    const data = await read(...args);
    if (String(args[0]) === path && !held) { held = true; captured.resolve(); await continueRead.promise; }
    return data;
  };
  /** Observe real native lock contention without changing the filesystem operation's outcome. */
  const interceptedOpen = async (...args: Parameters<typeof fs.open>) => {
    try { return await open(...args); }
    catch (error) {
      if (String(args[0]).includes('rlm-lease-release-race') && !String(args[0]).includes('cleanup') && (error as NodeJS.ErrnoException).code === 'EEXIST') blocked.resolve();
      throw error;
    }
  };
  t.mock.method(fs, 'readFile', interceptedRead as typeof fs.readFile);
  t.mock.method(fs, 'open', interceptedOpen);
  syncBuiltinESMExports();
  const first = unlock();
  try {
    await captured.promise;
    const second = unlock();
    const outcome = await Promise.race([second.then(() => 'released'), blocked.promise.then(() => 'serialized')]);
    if (outcome === 'released') {
      const peer = await new RlmLedger(workspace).lease('release-race');
      try { continueRead.resolve(); await first; assert.ok(await read(path, 'utf8')); }
      finally { await peer(); }
    } else {
      continueRead.resolve(); await Promise.all([first, second]);
      const peer = await new RlmLedger(workspace).lease('release-race');
      try { const owner = await read(path, 'utf8'); await unlock(); assert.equal(await read(path, 'utf8'), owner); }
      finally { await peer(); }
    }
    assert.equal(outcome, 'serialized');
  } finally { continueRead.resolve(); await first; t.mock.restoreAll(); syncBuiltinESMExports(); }
});

/** A metadata edit must never relabel an old model request as a newly matching question. */
test('selected source digests questions and depth are authenticated against their recorded prompts', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel(() => finish);
  const run = await runRlm('question', { workspace, model, reuse_identity: identity });
  const ledger = new RlmLedger(workspace);
  const valid = await ledger.load(run.run);
  const options = { workspace, settings: valid.settings, reuse_identity: identity, selection: { run: run.run, call: run.run } };
  for (const variant of ['digest', 'question', 'depth', 'prompt']) {
    const state = structuredClone(valid);
    let question = 'question';
    if (variant === 'digest') state.calls[0].digest = 'a'.repeat(64);
    if (variant === 'question') { question = 'forged question'; state.calls[0].subgoal = question; state.calls[0].digest = promptDigest(question, state.calls[0].slice, state.settings); }
    if (variant === 'depth') state.calls[0].depth = 1;
    if (variant === 'prompt') state.calls[0].steps[0].prompt += ' altered';
    await replaceCheckpointFixture(ledger, state);
    await assert.rejects(reuseRlm(question, options), { dimension: 'provenance' });
  }
  await replaceCheckpointFixture(ledger, valid);
  assert.equal((await reuseRlm('question', options)).status, 'reused');
  assert.equal(model.requests.length, 1);
});
