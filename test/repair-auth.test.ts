import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { repairRlm, resumeRepairRlm, compactRepairResult } from '../src/repair.ts';
import { emptyRootSlice, evidenceRlm, prepareRlmRun, replayRlm, resumeRlm, RlmEngine } from '../src/engine.ts';
import { promptDigest, RlmLedger } from '../src/ledger.ts';
import { RlmError } from '../src/errors.ts';
import { validateRepairResult } from '../src/repair-contract.ts';
import { runCommand } from '../src/commands.ts';
import { ScriptedModel, tracker } from './helpers.ts';
import { completedRepairFixture, interruptedRepair, repairFixture, repairJournal, repairPrompt, repaired, writeNativeCheckpoint } from './repair-fixture.ts';
import type { TestContext } from 'node:test';
import type { RlmModel, RlmState } from '../src/types.ts';

/** Stop the actual engine after its durable reservation, before any response is persisted. */
async function pendingRepair(t: TestContext) {
  const fixture = await repairFixture(t, 3, { endpoint: 'http://127.0.0.1:1' });
  let run = '';
  const interrupted = new ScriptedModel(() => { throw new Error('Synthetic transport interruption'); });
  await assert.rejects(repairRlm(fixture.request, { workspace: fixture.workspace, model: interrupted, on_transition: (phase, id) => { if (phase === 'created') run = id; } }));
  const journal = await repairJournal(fixture.client, run);
  const child = journal.targets[2].child;
  const state = await new RlmLedger(fixture.workspace).load(child);
  assert.equal(state.calls[0].steps.length, 1); assert.equal(state.calls[0].steps[0].response, undefined);
  let calls = 0;
  const probe: RlmModel = { name: interrupted.name, complete: async () => {
    calls++;
    return { text: JSON.stringify({ action: 'answer', components: [{ component: 'part2', status: 'unsupported', answer: '', reason: 'No new evidence', witnesses: [] }] }), tokens_in: 0, tokens_out: 0 };
  } };
  return { ...fixture, run, journal, child, state, probe, calls: () => calls };
}

/** One damaged component must return the supported remainder instead of refusing the whole answer. */
async function retained(work: ReturnType<typeof resumeRepairRlm>) {
  let receipt: Awaited<typeof work> | undefined;
  await assert.doesNotReject(async () => { receipt = await work; });
  assert.ok(receipt !== undefined);
  return repaired(receipt);
}

/** Both repair recovery and native resume must refuse before any model receives corrupt state. */
async function assertPendingRefused(setup: Awaited<ReturnType<typeof pendingRepair>>, state: RlmState): Promise<void> {
  const verifier = new RlmEngine(new RlmLedger(setup.workspace), state, setup.probe, undefined, true);
  await assert.rejects(verifier.validateRecorded(), RlmError);
  await writeNativeCheckpoint(setup.client, setup.child, state);
  const result = await retained(resumeRepairRlm(setup.run, { workspace: setup.workspace, model: setup.probe }));
  assert.equal(setup.calls(), 0, 'Unauthenticated pending state must not reach model transport');
  assert.deepEqual(result.gaps, ['part2']); assert.equal(result.components[2].reason, 'child_evidence');
  await assert.rejects(resumeRlm(setup.workspace, setup.child, setup.probe), { code: 'replay' });
  const context = { pm_root: setup.workspace, args: [setup.child], options: {}, global: { author: 'repair-auth' } } as CommandHandlerContext;
  await assert.rejects(runCommand('resume', context), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === 2 && error.message.includes('remedy:'));
  assert.equal(setup.calls(), 0);
}

/** Recomputed producer admission rejects understated reservations even when stored totals agree. */
test('pending repair holds authenticate required reservations before any model call', async t => {
  const setup = await pendingRepair(t);
  const corrupt = structuredClone(setup.state);
  corrupt.calls[0].steps[0].reserved = 0; corrupt.reserved_tokens = 0;
  await assertPendingRefused(setup, corrupt);
  let seed = 0x52657332;
  for (let sequence = 0; sequence < 500; sequence++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const state = structuredClone(setup.state);
    const amount = [0, 1, state.calls[0].steps[0].reserved - 1, state.calls[0].steps[0].reserved + 1, state.calls[0].steps[0].reserved + seed + 1, Number.MAX_SAFE_INTEGER][sequence % 6];
    state.calls[0].steps[0].reserved = amount; state.reserved_tokens = amount;
    await assert.rejects(new RlmEngine(new RlmLedger(setup.workspace), state, setup.probe, undefined, true).validateRecorded(), RlmError, `reservation sequence ${sequence}`);
  }
  await new RlmEngine(new RlmLedger(setup.workspace), setup.state, setup.probe, undefined, true).validateRecorded();
  const limited = structuredClone(setup.state); limited.settings.budget_tokens = 1;
  limited.calls[0].digest = promptDigest(limited.calls[0].subgoal, limited.calls[0].slice, limited.settings);
  await assert.rejects(new RlmEngine(new RlmLedger(setup.workspace), limited, setup.probe).validateRecorded(), { code: 'replay' });
});

/** Parent reads, child holds and child prompts share one native accounting and transport boundary. */
test('recursive pending inference authenticates the entire stored charge graph', async t => {
  const { workspace, client } = await tracker(t);
  const model = new ScriptedModel(request => {
    const input = repairPrompt(request);
    if (input.question === 'native child') throw new Error('Synthetic nested interruption');
    return JSON.stringify(input.transcript.length === 0 ? { action: 'list', filter: {} } : { action: 'spawn', subgoal: 'native child', slice: emptyRootSlice() });
  });
  const prepared = await prepareRlmRun('native root', { workspace, model, settings: { budget_tokens: 1000000 } });
  await assert.rejects(prepared.engine.run());
  const original = await prepared.ledger.load(prepared.run);
  assert.equal(original.calls.length, 2); assert.equal(original.calls[1].steps[0].response, undefined);
  const read = original.calls[0].steps[0].observation as { estimated_tokens: number };
  assert.ok(read.estimated_tokens > 0);
  const mutations: ((state: RlmState) => void)[] = [
    state => { state.reserved_tokens = 0; },
    state => { state.reserved_tokens -= state.calls[1].steps[0].reserved; state.calls[1].steps[0].reserved = 0; },
    state => { state.calls[1].steps[0].prompt = 'An unrelated child request'; },
    state => { state.calls[0].steps[1].observation = { result: 'Unwritten child result' }; },
    state => { state.calls[0].steps[0].observation = null; state.reserved_tokens -= read.estimated_tokens; },
    state => { state.question = 'Unrelated root declaration'; },
    state => { state.calls[1].depth = 0; state.calls[1].steps[0].prompt = state.calls[1].steps[0].prompt.replace('"depth":1', '"depth":0'); },
    state => { state.calls[0].depth = 1; },
    state => { state.calls = []; },
    state => { state.run = 'unrelated'; },
    state => { state.calls[1].id = state.calls[0].id; },
    state => { state.calls[1].parent = 'absent'; },
    state => { state.settings.max_calls = 1; },
    state => { state.settings.max_depth = 0; },
  ];
  for (const amount of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) mutations.push(state => { state.reserved_tokens = amount; });
  for (const amount of [0, -1, null, '2', Infinity, NaN, Number.MAX_SAFE_INTEGER]) mutations.push(state => {
    (state.calls[0].steps[0].observation as { estimated_tokens: unknown }).estimated_tokens = amount;
    state.reserved_tokens -= read.estimated_tokens;
    if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) state.reserved_tokens += amount;
  });
  for (const mutate of mutations) {
    const state = structuredClone(original); mutate(state);
    await assert.rejects(new RlmEngine(new RlmLedger(workspace), state, model).validateRecorded(), RlmError);
  }
  const limited = structuredClone(original); limited.settings.budget_tokens = original.reserved_tokens - 1;
  for (const call of limited.calls) call.digest = promptDigest(call.subgoal, call.slice, limited.settings);
  await assert.rejects(new RlmEngine(new RlmLedger(workspace), limited, model).validateRecorded(), { code: 'replay' });
  await new RlmEngine(new RlmLedger(workspace), original, model).validateRecorded();
  const legacyCounter = structuredClone(original); legacyCounter.reserved_tokens++;
  await new RlmEngine(new RlmLedger(workspace), legacyCounter, model).validateRecorded();
  await assert.rejects(new RlmEngine(new RlmLedger(workspace), legacyCounter, model, undefined, true).validateRecorded(), { code: 'replay' });
  let calls = 0;
  const probe: RlmModel = { name: model.name, complete: async () => { calls++; return { text: '{"action":"finish","answer":"done"}', tokens_in: 0, tokens_out: 0 }; } };
  const bad = structuredClone(original); bad.reserved_tokens = 0;
  await writeNativeCheckpoint(client, prepared.run, bad);
  await assert.rejects(resumeRlm(workspace, prepared.run, probe), { code: 'replay' }); assert.equal(calls, 0);
  const invalidRead = structuredClone(original);
  (invalidRead.calls[0].steps[0].observation as { estimated_tokens: unknown }).estimated_tokens = 'not a charge';
  await writeNativeCheckpoint(client, prepared.run, invalidRead);
  const unlock = await prepared.ledger.lease(prepared.run);
  try {
    const current = await prepared.ledger.load(prepared.run);
    const engine = new RlmEngine(prepared.ledger, current, probe);
    await assert.rejects(engine.spawn(current.calls[0].id, current.calls[1].subgoal, current.calls[1].slice), { code: 'replay' });
    assert.equal(calls, 0);
  } finally { await unlock(); }
  await writeNativeCheckpoint(client, prepared.run, original);
  assert.equal((await resumeRlm(workspace, prepared.run, probe)).answer, 'done'); assert.equal(calls, 2);
  assert.equal((await replayRlm(workspace, prepared.run)).answer, 'done');
});

/** Completed coverage and repair provenance cannot authenticate a question using a substituted prompt. */
test('completed evidence prompts remain authenticated during reports and repair continuation', async t => {
  const { workspace, request, client, model, complete } = await completedRepairFixture(t, 1);
  const child = complete.components[0].run;
  const state = await new RlmLedger(workspace).load(child);
  for (const action of [{ action: 'finish', answer: 'unwritten' }, { action: 'answer', components: [] }, { action: 'spawn', subgoal: 'unwritten', slice: emptyRootSlice() }]) {
    const unfinished = structuredClone(state); delete unfinished.calls[0].result; delete unfinished.calls[0].steps[0].observation;
    unfinished.calls[0].steps[0].response!.text = JSON.stringify(action);
    await assert.rejects(new RlmEngine(new RlmLedger(workspace), unfinished, model).validateRecorded(), RlmError);
  }
  state.calls[0].steps[0].prompt = state.calls[0].steps[0].prompt.replace('Explain source 0', 'Invent! source 0');
  assert.ok(state.calls[0].steps[0].prompt.includes('Invent! source 0'));
  await writeNativeCheckpoint(client, child, state);
  await assert.rejects(evidenceRlm(workspace, child), { code: 'replay' });
  const result = repaired(await resumeRepairRlm(complete.run, { workspace, model }));
  assert.deepEqual(result.gaps, ['part0']); assert.equal(result.components[0].reason, 'child_evidence');
  const continued = repaired(await repairRlm({ ...request, source: complete.run, budget_tokens: 0 }, { workspace, model }));
  assert.deepEqual(continued.gaps, ['part0']); assert.equal(continued.reused, 0); assert.equal(model.requests.length, 2);
});

/** Settled usage remains bounded by the original producer hold even when all saved counters agree. */
test('settled evidence usage cannot exceed its producer reservation or total budget', async t => {
  const { workspace, client, complete, model } = await completedRepairFixture(t, 1);
  const child = complete.components[0].run;
  const original = await new RlmLedger(workspace).load(child);
  for (const mode of ['step', 'total']) {
    const state = structuredClone(original);
    if (mode === 'step') {
      const step = state.calls[0].steps[0];
      const amount = Buffer.byteLength(step.prompt) + state.settings.output_tokens * 16 + 1;
      state.reserved_tokens += amount - step.reserved; step.reserved = amount;
      step.response!.tokens_in = amount; step.response!.tokens_out = 0;
    } else state.reserved_tokens = state.settings.budget_tokens + 1;
    await assert.rejects(new RlmEngine(new RlmLedger(workspace), state, model, undefined, true).validateRecorded(), RlmError);
    await writeNativeCheckpoint(client, child, state);
    assert.deepEqual((await retained(resumeRepairRlm(complete.run, { workspace, model }))).gaps, ['part0']);
  }
  assert.equal(model.requests.length, 2);
});

/** A recorded successful history action cannot bypass the immutable source policy on replay. */
test('read verification revalidates immutable history policy before accepting stored observations', async t => {
  const { workspace, client } = await tracker(t);
  const source = (await client.create({ title: 'Public history fixture', parent: 'none' })).item.id;
  const model = new ScriptedModel((_request, index) => index === 0 ? JSON.stringify({ action: 'history', id: source, start: 0, end: 1 }) : '{"action":"finish","answer":"history verified"}');
  const prepared = await prepareRlmRun('Read declared history', { workspace, scope: { ids: [source] }, model });
  await prepared.engine.run();
  const state = await prepared.ledger.load(prepared.run);
  await new RlmEngine(new RlmLedger(workspace), state, model).validateRecorded();
  state.snapshot_only = true;
  await assert.rejects(new RlmEngine(new RlmLedger(workspace), state, model).validateRecorded(), { code: 'replay' });
});

/** Equal-length corruption isolates prompt authentication from reservation and root-contract checks. */
test('pending repair prompts authenticate the saved request before model transport', async t => {
  const setup = await pendingRepair(t);
  const corrupt = structuredClone(setup.state);
  const before = corrupt.calls[0].steps[0].prompt;
  corrupt.calls[0].steps[0].prompt = before.replace('Explain source 2', 'Invent! source 2');
  assert.notEqual(corrupt.calls[0].steps[0].prompt, before);
  assert.equal(Buffer.byteLength(corrupt.calls[0].steps[0].prompt), Buffer.byteLength(before));
  await assertPendingRefused(setup, corrupt);
  for (const mutation of [
    (state: RlmState) => { state.calls[0].steps[0].prompt = 'unrelated instructions'; },
    (state: RlmState) => { state.calls[0].digest = '0'.repeat(64); },
    (state: RlmState) => { state.calls[0].steps.push(structuredClone(state.calls[0].steps[0])); state.reserved_tokens *= 2; },
  ]) {
    const state = structuredClone(setup.state); mutation(state);
    await assert.rejects(new RlmEngine(new RlmLedger(setup.workspace), state, setup.probe, undefined, true).validateRecorded());
  }
});

/** A real full hold may settle to zero actual usage; valid recovered work remains admissible. */
test('genuine pending producer holds permit zero reported usage and retain native receipts', async t => {
  const setup = await pendingRepair(t);
  const result = repaired(await resumeRepairRlm(setup.run, { workspace: setup.workspace, model: setup.probe }));
  assert.equal(setup.calls(), 1); assert.equal(result.budget.charged, 0);
  assert.equal(result.components[2].reason, 'evidence');
  const native = await new RlmLedger(setup.workspace).load(setup.child);
  assert.equal(native.calls[0].steps[0].settled, true); assert.equal(native.calls[0].steps[0].reserved, 0);
  assert.deepEqual(repaired(await resumeRepairRlm(setup.run, { workspace: setup.workspace, model: setup.probe })), result);
  assert.equal(setup.calls(), 1);
});

/** Current evidence availability controls every component disposition and reuse counter. */
test('unavailable prior repair evidence stays a gap with a remedy instead of reused', async t => {
  const { workspace, request, ids, client, model, complete } = await completedRepairFixture(t);
  const { run } = await interruptedRepair(workspace, { ...request, source: complete.run, budget_tokens: 0 }, model, 'created', client);
  await client.update(complete.components[2].run, { tags: 'foreign' });
  const result = await retained(resumeRepairRlm(run, { workspace, model }));
  assert.equal(result.reused, 2); assert.deepEqual(result.gaps, ['part2']);
  const gap = result.components[2];
  assert.equal(gap.disposition, 'gap'); assert.equal(gap.reason, 'prior_child_unavailable'); assert.ok(gap.remedy.length > 0);
  assert.equal(result.components.filter(part => part.status === 'supported').length, 2);
  assert.equal(compactRepairResult(result).reused, 2);
  assert.deepEqual(repaired(await resumeRepairRlm(run, { workspace, model })), result);
  for (const disposition of ['reused', 'repaired'] as const) {
    const bad = structuredClone(result); bad.components[2].disposition = disposition; bad.components[2].remedy = '';
    if (disposition === 'reused') bad.reused++;
    assert.throws(() => validateRepairResult(bad), RlmError); assert.throws(() => compactRepairResult(bad), RlmError);
  }
  for (const mutate of [
    (value: typeof result) => { value.reused++; },
    (value: typeof result) => { value.components[0].disposition = 'gap'; },
    (value: typeof result) => { value.components[0].remedy = 'Unexpected supported remedy'; },
    (value: typeof result) => { value.components[2].remedy = ' \r\n '; },
  ]) {
    const bad = structuredClone(result); mutate(bad);
    assert.throws(() => compactRepairResult(bad), RlmError);
  }
  assert.equal((await client.get(ids[1], { depth: 'full' })).item.parent, undefined);
  await client.update(complete.components[2].run, { tags: 'rlm:call' });
  const restored = repaired(await resumeRepairRlm(run, { workspace, model }));
  assert.equal(restored.status, 'complete'); assert.equal(restored.reused, 3); assert.deepEqual(restored.gaps, []);
});
