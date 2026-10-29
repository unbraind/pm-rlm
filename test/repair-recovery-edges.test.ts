import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { RlmLedger, promptDigest, reserveStep, settleStep } from '../src/ledger.ts';
import { prepareRlmRun, replayRlm, resumeRlm, RlmEngine, runRlm, emptyRootSlice } from '../src/engine.ts';
import { repairRlm, resumeRepairRlm } from '../src/repair.ts';
import { blobDigest } from '../src/blobs.ts';
import { completedRepairFixture, repairFixture, repairJournal, repaired } from './repair-fixture.ts';
import { ScriptedModel } from './helpers.ts';
import type { RlmState } from '../src/types.ts';

/** Legacy held responses settle through the native producer without refunding completed evidence. */
test('repair legacy response holds retain authoritative settled usage through SDK save', async t => {
  const { workspace, complete, model } = await completedRepairFixture(t, 1);
  const ledger = new RlmLedger(workspace); const run = complete.components[0].run;
  const unlock = await ledger.lease(run);
  try {
    const state = await ledger.load(run); const original = structuredClone(state);
    for (const call of state.calls) for (const step of call.steps) {
      const hold = reserveStep({ settings: state.settings, reserved_tokens: 0 }, { ...call, steps: [] }, step.prompt);
      state.reserved_tokens += hold.reserved - step.reserved; step.reserved = hold.reserved; delete step.settled;
    }
    await ledger.save(state);
    const observed = await ledger.load(run);
    assert.deepEqual(observed, state);
    for (const call of observed.calls) for (const step of call.steps) settleStep(observed, step, step.response!);
    await ledger.save(observed);
    assert.deepEqual(await new RlmLedger(workspace).load(run), original);
  } finally { await unlock(); }
  assert.deepEqual(repaired(await resumeRepairRlm(complete.run, { workspace, model })), complete);
  assert.equal(model.requests.length, 2);
});

/** A corrupt immutable publisher payload fails independently of the current checkpoint reader. */
test('repair publisher refuses missing records and damaged historical payloads', async t => {
  const { workspace, complete, client } = await completedRepairFixture(t, 1);
  const run = complete.components[0].run; const ledger = new RlmLedger(workspace);
  await assert.rejects(ledger.publishedState('missing-native-publisher'), { code: 'incomplete' });
  const item = (await client.listAllComplete()).items.find(item => item.id === run)!;
  const manifest = JSON.parse(String(item.rlm_state)) as { snapshot: string };
  const path = join(workspace, 'rlm-blobs', manifest.snapshot + '.json');
  const bytes = await readFile(path);
  try { await writeFile(path, 'corrupt'); await assert.rejects(ledger.publishedState(run), { code: 'incomplete' }); }
  finally { await writeFile(path, bytes); }
  assert.deepEqual(await ledger.publishedState(run), await ledger.load(run));
});

/** A foreign canonical birth cannot turn an old cleared intent into fresh spending. */
test('repair cleared malformed birth retains supported peers without inferring', async t => {
  const { workspace, request, client } = await repairFixture(t);
  let run = '';
  await assert.rejects(repairRlm(request, { workspace, on_transition: (phase, id) => { if (phase === 'created') { run = id; throw new Error('Synthetic interruption'); } } }));
  const id = `${run}-r2`;
  await client.run('create', { options: { id, title: 'Foreign canonical record', type: 'Task', parent: run, tags: 'rlm:call', rlmRun: id, rlmState: '{}' } });
  const before = (await client.get(id, { depth: 'full' })).item;
  const model = new ScriptedModel(() => assert.fail('Foreign birth cannot authorize inference'));
  const result = repaired(await resumeRepairRlm(run, { workspace, model }));
  assert.equal(result.reused, 2); assert.deepEqual(result.gaps, ['part2']); assert.equal(result.budget.remaining, 0);
  assert.deepEqual((await client.get(id, { depth: 'full' })).item, before);
  assert.equal(model.requests.length, 0);
});

/** Valid native runs with the wrong component declaration fail only their requested repair part. */
test('repair continuation authenticates missing wrong and extra native components', async t => {
  const { workspace, request, client, complete } = await completedRepairFixture(t, 1);
  const good = await new RlmLedger(workspace).load(complete.components[0].run, '1');
  for (const components of [undefined, ['wrong'], ['part0', 'extra']]) {
    let run = '';
    await assert.rejects(repairRlm(request, { workspace, on_transition: (phase, id) => { if (phase === 'created') { run = id; throw new Error('Synthetic stopped intent'); } } }));
    const model = new ScriptedModel(() => JSON.stringify(components === undefined ? { action: 'finish', answer: 'Unrelated declaration' } : { action: 'answer', components: components.map(component => ({ component, status: 'unsupported', answer: '', reason: 'Foreign declaration', witnesses: [] })) }));
    const forged = await prepareRlmRun(good.question, { workspace, question_item: run, settings: good.settings, scope: good.scope, components, snapshot_only: true, reuse_identity: { ...good.reuse_identity!, consent: blobDigest(run) }, model }, undefined, `${run}-r0`);
    await forged.engine.run();
    const journal = await repairJournal(client, run);
    Object.assign(journal.targets[0], { child: forged.run, allowance: good.settings.budget_tokens, phase: 'complete', reason: '' });
    await client.update(run, { description: 'RLM repair v1\n' + JSON.stringify(journal) });
    let result: Awaited<ReturnType<typeof repairRlm>> | undefined;
    await assert.doesNotReject(async () => { result = await repairRlm({ ...request, source: run, budget_tokens: 0 }, { workspace }); });
    assert.ok(result && result.status === 'partial'); assert.deepEqual(result.gaps, ['part0']); assert.equal(result.reused, 0);
  }
});

/** Resume may finish a genuine producer response interrupted before parsing, without replaying inference. */
test('repair verifier preserves an interrupted unobserved parse response', async t => {
  const { workspace, ids } = await repairFixture(t, 1);
  const model = new ScriptedModel((_request, index) => index === 0 ? 'invalid JSON action' : '{"action":"answer","components":[{"component":"part0","status":"unsupported","answer":"","reason":"Fixture gap","witnesses":[]}]}');
  const prepared = await prepareRlmRun('Interrupted parse', { workspace, scope: { ids }, components: ['part0'], model });
  const save = prepared.ledger.save.bind(prepared.ledger);
  let stopped = false;
  t.mock.method(prepared.ledger, 'save', async (state: RlmState) => {
    await save(state);
    if (!stopped && state.calls[0].steps[0]?.response !== undefined && state.calls[0].steps[0].observation === undefined) { stopped = true; throw new Error('Synthetic response interruption'); }
  });
  await assert.rejects(prepared.engine.run()); t.mock.restoreAll(); assert.equal(stopped, true);
  const state = await prepared.ledger.load(prepared.run);
  await new RlmEngine(prepared.ledger, state, model).validateRecorded();
  await assert.rejects(replayRlm(workspace, prepared.run), { code: 'replay' });
  const result = await resumeRlm(workspace, prepared.run, model);
  assert.equal(result.components![0].status, 'unsupported'); assert.equal(model.requests.length, 2);
  assert.deepEqual(await replayRlm(workspace, prepared.run), result);
});

/** Ordinary replay also rejects a valid-shaped but unreferenced terminal call. */
test('repair shared verifier preserves ordinary replay graph completeness', async t => {
  const { workspace, client } = await repairFixture(t, 1);
  const model = new ScriptedModel(() => '{"action":"finish","answer":"Complete"}');
  const result = await runRlm('Ordinary graph', { workspace, model });
  const ledger = new RlmLedger(workspace); const state = await ledger.load(result.run);
  const slice = emptyRootSlice();
  state.calls.push({ id: `${state.run}-orphan`, parent: state.run, depth: 1, subgoal: 'Orphan', slice, digest: promptDigest('Orphan', slice, state.settings), steps: [], result: 'Unrecorded terminal call' });
  await client.run('update', { id: state.run, options: { rlmState: JSON.stringify(state) } });
  await assert.rejects(replayRlm(workspace, state.run), { code: 'replay' });
});

/** Legacy native births without a checkpoint remain resumable through their explicit owner fields. */
test('repair verifier preserves ordinary legacy births without initial checkpoint data', async t => {
  const { workspace, client } = await repairFixture(t, 1);
  const model = new ScriptedModel(() => '{"action":"finish","answer":"Legacy complete"}');
  const original = await prepareRlmRun('Legacy ordinary birth', { workspace, model });
  const state = await original.ledger.load(original.run);
  const run = await original.ledger.newRunId(); state.run = run; state.calls[0].id = run;
  await client.run('create', { options: { id: run, title: 'Legacy native root', type: 'Task', parent: state.calls[0].parent!, tags: 'rlm:call', rlmRun: run } });
  await client.run('update', { id: run, options: { rlmState: JSON.stringify(state) } });
  const result = await resumeRlm(workspace, run, model);
  assert.equal(result.answer, 'Legacy complete'); assert.equal(model.requests.length, 1);
});

/** Removing declarations from an evidence run cannot turn it into an ordinary unverified run. */
test('repair verifier retains initial component protection when current declarations disappear', async t => {
  const { workspace, complete, client, model } = await completedRepairFixture(t, 1);
  const source = complete.source; const ledger = new RlmLedger(workspace);
  const state = await ledger.load(source); delete state.components;
  await client.run('update', { id: source, options: { rlmState: JSON.stringify(state) } });
  await assert.rejects(resumeRlm(workspace, source, model), { code: 'replay' });
});

/** The saved legacy parser rejects modern proof actions before reconstructing a missing read. */
test('repair interrupted legacy proof reads refuse modern actions under their saved parser', async t => {
  const { workspace, complete, model } = await completedRepairFixture(t, 1);
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(complete.components[0].run);
  delete state.parser_version; delete state.calls[0].result; delete state.calls[0].steps[0].observation;
  await assert.rejects(new RlmEngine(ledger, state, model).validateRecorded(false, true), { code: 'invalid', message: 'Unknown model action' });
  assert.equal(model.requests.length, 2);
});
