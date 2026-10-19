import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tracker, ScriptedModel } from './helpers.ts';
import { runRlm, replayRlm, resumeRlm, treeRlm } from '../src/engine.ts';
import { RlmError, estimateTokens } from '../src/errors.ts';
import { RlmLedger } from '../src/ledger.ts';
import { PROTOCOL } from '../src/protocol.ts';
import { readRlmSettings } from '../src/settings.ts';
import { RlmContext } from '../src/environment.ts';
import { rootIds } from './live.ts';
import type { ModelRequest } from '../src/types.ts';

/** Read only the protocol envelope emitted by the engine, not tracker implementation data. */
function input(request: ModelRequest): { depth: number; transcript: { observation: unknown }[] } { return JSON.parse(request.prompt.slice(PROTOCOL.length + 1)); }

for (const failure of ['model', 'budget'] as const) {
  test(`terminal child ${failure} refusal survives replay and resume (#4)`, async t => {
    const { workspace, client } = await tracker(t);
    const model = new ScriptedModel(request => {
      const value = input(request);
      if (value.depth === 1) throw new RlmError(failure, 'Transient child failure');
      return JSON.stringify(value.transcript.length < 2 ? { action: 'spawn', subgoal: 'child', slice: { fragments: [], estimated_tokens: 2 } } : { action: 'finish', answer: 'recovered' });
    });
    const result = await runRlm('root', { workspace, model });
    assert.equal(result.answer, 'recovered');
    const state = await new RlmLedger(workspace).load(result.run);
    assert.partialDeepStrictEqual(state.calls[1].failure, { code: failure });
    assert.equal(model.requests.filter(request => input(request).depth === 1).length, 1);
    assert.equal((await replayRlm(workspace, result.run)).answer, 'recovered');
    const requests = model.requests.length;
    assert.equal((await resumeRlm(workspace, result.run, model)).answer, 'recovered');
    assert.equal(model.requests.length, requests);
    const rows = (await treeRlm(workspace, result.run)).calls as { status: string }[];
    assert.deepEqual(rows.map(row => row.status), ['closed', 'failed']);
    const child = (await client.get(state.calls[1].id)).item;
    assert.equal(child.status, 'closed');
    assert.ok(JSON.stringify(await client.comments(child.id)).includes('RLM refusal:'));
  });
}

test('oversized read is refused before charging and root can finish', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Large item', type: 'Task', description: 'x'.repeat(8000) })).item;
  const model = new ScriptedModel((_request, index) => JSON.stringify(index === 0 ? { action: 'get', id: item.id, fields: ['description'] } : { action: 'finish', answer: 'recovered' }));
  const result = await runRlm('root', { workspace, model, settings: { context_tokens: 4096, output_tokens: 96 } }).catch(error => assert.fail(`Run should recover: ${String(error)}`));
  const state = await new RlmLedger(workspace).load(result.run);
  assert.partialDeepStrictEqual(state.calls[0].steps[0].observation, { refused: 'budget' });
  assert.equal(result.reserved_tokens, state.calls[0].steps.reduce((sum, step) => sum + step.reserved, 0));
  assert.equal((await replayRlm(workspace, result.run)).answer, 'recovered');
});

test('privacy applies to persisted scoped items only', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Excluded', type: 'Issue', description: workspace });
  await client.create({ title: 'Included', type: 'Task' });
  const model = new ScriptedModel(() => '{"action":"finish","answer":"ok"}');
  const result = await runRlm('scope', { workspace, scope: { type: 'Task' }, model }).catch(error => assert.fail(`Scoped run should succeed: ${String(error)}`));
  assert.equal(result.answer, 'ok');
  await assert.rejects(runRlm('full', { workspace, model }), { code: 'invalid' });
});

test('default calibration fits protocol two partitions and two child calls', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Synthetic long context', type: 'Task', description: 'synthetic'.repeat(28000) });
  const model = new ScriptedModel(request => {
    const value = input(request);
    if (value.depth === 1) return '{"action":"finish","answer":"child"}';
    const actions = [
      { action: 'partition', filter: {}, maxTokens: 2000 },
      { action: 'partition', filter: {}, maxTokens: 2000 },
      { action: 'spawn', subgoal: 'first synthetic task', slice: { partition_step: 0, index: 0 } },
      { action: 'spawn', subgoal: 'second synthetic task', slice: { partition_step: 1, index: 1 } },
      { action: 'finish', answer: 'two children' },
    ];
    return JSON.stringify(actions[value.transcript.length]);
  });
  const result = await runRlm('synthetic calibration', { workspace, model });
  assert.equal(result.calls, 3);
  assert.equal(result.answer, 'two children');
  const settings = await readRlmSettings(workspace);
  assert.ok(result.reserved_tokens < settings.budget_tokens);
  assert.ok(model.requests.every(request => estimateTokens(request.prompt) + request.max_output_tokens <= request.context_tokens));
  assert.equal((await replayRlm(workspace, result.run)).answer, result.answer);
});

test('child context refusal after creation records a terminal outcome (#4)', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Context boundary', type: 'Task', description: 'x'.repeat(3000) });
  const model = new ScriptedModel(request => {
    const value = input(request);
    assert.equal(value.depth, 0, 'Oversized child must refuse before inference');
    return JSON.stringify([
      { action: 'partition', filter: {}, maxTokens: 3500 },
      { action: 'spawn', subgoal: 'child', slice: { partition_step: 0, index: 0 } },
      { action: 'finish', answer: 'context recovered' },
    ][value.transcript.length]);
  });
  const result = await runRlm('root', { workspace, model, settings: { context_tokens: 4096, output_tokens: 96 } });
  const state = await new RlmLedger(workspace).load(result.run);
  assert.equal(state.calls.length, 2);
  assert.partialDeepStrictEqual(state.calls[1].failure, { code: 'budget' });
  assert.equal(state.calls[1].steps.length, 0);
  assert.equal((await replayRlm(workspace, result.run)).answer, result.answer);
  assert.equal((await resumeRlm(workspace, result.run, model)).answer, result.answer);
});

test('partition references fail closed and completed oversized child results remain replayable', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Reference source', type: 'Task' })).item;
  const actions = [
    { action: 'spawn', subgoal: 'unavailable', slice: { partition_step: 0, index: 0 } },
    { action: 'get', id: item.id, fields: ['title'] },
    { action: 'spawn', subgoal: 'wrong action', slice: { partition_step: 1, index: 0 } },
    { action: 'partition', filter: { type: 'Issue' }, maxTokens: 500 },
    { action: 'spawn', subgoal: 'missing slice', slice: { partition_step: 3, index: 0 } },
    { action: 'finish', answer: 'references refused' },
  ];
  const model = new ScriptedModel(request => JSON.stringify(actions[input(request).transcript.length]));
  const result = await runRlm('invalid references', { workspace, model });
  assert.equal(result.calls, 1);
  assert.equal((await replayRlm(workspace, result.run)).answer, result.answer);
  const referenceLedger = new RlmLedger(workspace);
  const changed = await referenceLedger.load(result.run);
  changed.calls[0].steps[0].observation = { refused: 'budget' };
  await referenceLedger.save(changed);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
  const large = new ScriptedModel(request => {
    const value = input(request);
    return JSON.stringify(value.depth === 1 ? { action: 'finish', answer: 'x'.repeat(3000) } : value.transcript.length === 0 ? { action: 'spawn', subgoal: 'large answer', slice: { fragments: [], estimated_tokens: 2 } } : { action: 'finish', answer: 'recovered' });
  });
  const largeRun = await runRlm('large child', { workspace, model: large, settings: { context_tokens: 4096 } });
  const state = await new RlmLedger(workspace).load(largeRun.run);
  assert.partialDeepStrictEqual(state.calls[0].steps[0].observation, { refused: 'budget' });
  assert.equal(state.calls[1].result?.length, 3000);
  assert.equal((await replayRlm(workspace, largeRun.run)).answer, 'recovered');
});

test('child interruption remains resumable and terminal refusal tampering fails replay', async t => {
  const { workspace } = await tracker(t);
  const broken = new ScriptedModel(request => {
    if (input(request).depth === 1) throw new Error('Process-like interruption');
    return '{"action":"spawn","subgoal":"child","slice":{"fragments":[],"estimated_tokens":2}}';
  });
  await assert.rejects(runRlm('interrupted child', { workspace, model: broken }), /Process-like interruption/);
  const [run] = await rootIds(workspace);
  const recovered = new ScriptedModel(request => JSON.stringify({ action: 'finish', answer: input(request).depth === 1 ? 'child' : 'root' }));
  assert.equal((await resumeRlm(workspace, run, recovered)).answer, 'root');
  const typed = new ScriptedModel(request => {
    const value = input(request);
    if (value.depth === 1) throw new RlmError('model', 'Typed child failure');
    return JSON.stringify(value.transcript.length === 0 ? { action: 'spawn', subgoal: 'typed', slice: { fragments: [], estimated_tokens: 2 } } : { action: 'finish', answer: 'root' });
  });
  const result = await runRlm('typed', { workspace, model: typed });
  const ledger = new RlmLedger(workspace); const state = await ledger.load(result.run);
  const unfinished = structuredClone(state); delete unfinished.calls[1].failure; await ledger.save(unfinished);
  await assert.rejects(resumeRlm(workspace, result.run, typed), { code: 'replay' });
  state.calls[1].failure = { code: 'budget' }; await ledger.save(state);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
});

test('typed completion hook refusal preserves a child result already recorded', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel(request => {
    const value = input(request);
    return JSON.stringify(value.depth === 1 || value.transcript.length > 0 ? { action: 'finish', answer: 'ok' } : { action: 'spawn', subgoal: 'hooked child', slice: { fragments: [], estimated_tokens: 2 } });
  });
  const result = await runRlm('hook interruption', { workspace, model, on_call_complete: call => { if (call.depth === 1) throw new RlmError('model', 'Hook refused'); } });
  const state = await new RlmLedger(workspace).load(result.run);
  assert.equal(state.calls[1].result, 'ok'); assert.equal(state.calls[1].failure, undefined);
  assert.equal((await replayRlm(workspace, result.run)).answer, 'ok');
});

test('partition index refuses the exact remaining run budget before delivery', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Partition budget', type: 'Task' });
  const model = { name: 'full-reservation-test', complete: async (request: ModelRequest) => ({ text: '{"action":"partition","filter":{},"maxTokens":1000}', tokens_in: estimateTokens(request.prompt), tokens_out: request.max_output_tokens * 16 }) };
  const config = await readRlmSettings(workspace);
  const prompt = `${PROTOCOL}\n${JSON.stringify({ question: 'partition budget', depth: 0, slice: { fragments: [], estimated_tokens: 2 }, transcript: [] })}`;
  await assert.rejects(runRlm('partition budget', { workspace, model, settings: { budget_tokens: estimateTokens(prompt) + config.output_tokens * 16 } }), { code: 'budget' });
  const [run] = await rootIds(workspace);
  const state = await new RlmLedger(workspace).load(run);
  assert.partialDeepStrictEqual(state.calls[0].steps[0].observation, { refused: 'budget' });
  assert.equal(state.calls[0].steps.length, 1);
});

/** Recorded full partition observations remain replayable after compact references were introduced. */
test('replay retains existing full-slice partition receipts and rejects changed legacy data', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Legacy partition', type: 'Task' });
  const model = new ScriptedModel((_request, index) => JSON.stringify(index === 0 ? { action: 'partition', filter: {}, maxTokens: 2000 } : { action: 'finish', answer: 'legacy' }));
  const result = await runRlm('legacy partition', { workspace, model });
  const ledger = new RlmLedger(workspace); const state = await ledger.load(result.run);
  const context = new RlmContext(workspace, state.snapshot, state.certificate, state.settings.budget_tokens);
  const read = await context.partition({}, 2000);
  state.calls[0].steps[0].observation = read;
  await ledger.save(state);
  assert.equal((await replayRlm(workspace, result.run)).answer, 'legacy');
  read.estimated_tokens++;
  await ledger.save(state);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
});
