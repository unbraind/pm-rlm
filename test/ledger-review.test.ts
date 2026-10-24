import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExtensionCommandSdk } from '@unbrained/pm-cli/sdk';
import { RlmBlobs } from '../src/blobs.ts';
import { RlmLedger } from '../src/ledger.ts';
import { runRlm } from '../src/engine.ts';
import { testEnvironment } from '../scripts/environment.ts';
import { ScriptedModel, tracker } from './helpers.ts';
import { verifyScaleCollection } from './ledger-scale-check.ts';

/** Exercise the benchmark's actual post-sweep checks on three real non-git roots. */
test('scale collection verifies zero removals and all sampled post-sweep roots', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Public scale fixture' });
  const result = await runRlm('finish', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"checked"}') });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(result.run);
  const sdk = createExtensionCommandSdk(workspace, client, 'scale-review-fixture');
  await sdk.mutateWorkspaceSettings({ operationId: 'scale-fixture-id-prefix', mutate: current => ({ ...current, id_prefix: 'scale-' }) });
  for (const run of [1, 250, 500]) {
    const sample = structuredClone(state);
    sample.run = `scale-run-${run}`; sample.calls[0].id = sample.run;
    delete sample.calls[0].parent;
  const unlock = await ledger.lease(sample.run);
  try { await ledger.materialize(sample, sample.calls[0]); } finally { await unlock(); }
  }
  await verifyScaleCollection(ledger);
  const blobs = new RlmBlobs(workspace);
  await blobs.put('orphan must invalidate benchmark success');
  await assert.rejects(verifyScaleCollection(ledger), /Scale fixture has no orphan blobs/);
  const gc = ledger.gc.bind(ledger);
  for (const run of [1, 250, 500]) {
    const manifest = JSON.parse(String((await client.get(`scale-run-${run}`, { depth: 'full' })).item.rlm_state)) as { transcript: string };
    const path = join(workspace, 'rlm-blobs', `${manifest.transcript}.json`);
    const original = await readFile(path);
    // Simulate a sweep that incorrectly deletes a reachable payload after completing the mark.
    t.mock.method(ledger, 'gc', async () => { const collected = await gc(); await rm(path); return collected; });
    await assert.rejects(verifyScaleCollection(ledger), { code: 'incomplete' });
    t.mock.restoreAll();
    await writeFile(path, original);
  }
});

/** Non-Linux test discovery must skip both drills before touching platform-specific facilities. */
test('partial-write drills skip on non-Linux platforms', () => {
  const bootstrap = 'data:text/javascript,' + encodeURIComponent('Object.defineProperty(process, "platform", { value: "darwin" });');
  const child = spawnSync(process.execPath, ['--import', bootstrap, '--test', '--test-reporter=tap', '--test-name-pattern', '^SIGKILL during', 'test/ledger-storage.test.ts'], { env: testEnvironment(process.env), encoding: 'utf8', timeout: 120000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /# pass 0\b/);
  assert.match(child.stdout, /# skipped 2\b/);
  assert.equal(child.stdout.match(/requires \/proc and SIGSTOP/g)?.length, 2);
});

/** A digest verified earlier is not proof that its current on-disk bytes remain intact. */
test('blob reuse rechecks previously verified digests after same-size corruption', async t => {
  const { workspace } = await tracker(t);
  const blobs = new RlmBlobs(workspace);
  const value = 'immutable public value';
  const digest = await blobs.put(value);
  assert.equal(await blobs.get(digest), value);
  const path = join(workspace, 'rlm-blobs', `${digest}.json`);
  await writeFile(path, JSON.stringify('corrupted public value'));
  assert.equal((await readFile(path)).length, Buffer.byteLength(JSON.stringify(value)));
  await assert.rejects(blobs.put(value), { code: 'incomplete' });
  await assert.rejects(new RlmBlobs(workspace).put(value), { code: 'incomplete' });
});
