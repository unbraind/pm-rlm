import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseAction, extractObject } from '../src/protocol.ts';
import { aggregateItems, parseAggregate } from '../src/aggregates.ts';
import { createRlmContext, readCorpus } from '../src/environment.ts';
import { runRlm, replayRlm, resumeRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { estimateTokens } from '../src/errors.ts';
import { stuffingAnswer } from './live.ts';
import { ScriptedModel, tracker } from './helpers.ts';
import type { RlmAggregate, RlmItem } from '../src/types.ts';

/** Preserve the actual retained numeric-answer refusal; wrapper cases are explicitly synthetic. */
test('v2 parser accepts presentation wrappers and refuses schema drift or ambiguity', () => {
  assert.equal(stuffingAnswer('```json\n{"answer":"12"}\n```'), '12');
  assert.equal(stuffingAnswer('{"answer":"12"}{"answer":"13"}'), '');
  const action = { action: 'count', filter: {} };
  for (const output of ['{"action":"count"}', '```json\n{"action":"count"}\n```', 'First I will count. {"action":"count"} Done.', '<think>{"not":"an action"}</think> {"action":"count"}', '{"action":"count"}<think>{reasoning}</think>']) assert.doesNotThrow(() => assert.deepEqual(parseAction(output), action));
  assert.deepEqual(parseAction(JSON.stringify({ action: 'finish', answer: 'a } { " \\ b' })), { action: 'finish', answer: 'a } { " \\ b' });
  assert.deepEqual(parseAction(JSON.stringify({ action: 'finish', answer: '<think>x</think> ```json' })), { action: 'finish', answer: '<think>x</think> ```json' });
  assert.equal(extractObject('prefix {"nested":{"x":1}} suffix'), '{"nested":{"x":1}}');
  for (const output of ['{"action":"finish","answer":0}', '{"tool":"count"}', '{"action":"count"} {"action":"count"}', '[{"action":"count"}]', '{"action":"count"', '<think>unfinished {"action":"count"}', 'no action', '{bad}', '{"action":"count","action":"sum"}', '{"action":"count"}<think>unfinished', '}{"action":"count"}', '{"action":"finish","answer":"unfinished']) assert.throws(() => parseAction(output), { code: 'invalid' });
});

/** A real delivered response requires envelope extraction while retaining the exact aggregate schema. */
test('v2 parser recorded prose action reaches the typed environment', () => {
  const output = readFileSync(new URL('./fixtures/glm-5.3-prose-action.txt', import.meta.url), 'utf8');
  assert.throws(() => JSON.parse(output), SyntaxError);
  assert.doesNotThrow(() => assert.deepEqual(parseAction(output), { action: 'argmax', filter: { type: 'Decision' }, numeric_expr: 'len(title)' }));
});

/** Exact first live response: missing opening reasoning delimiter leaves two candidate actions. */
test('v2 recorded cloud reasoning shape remains a refusal without an explicit boundary', () => {
  const output = readFileSync(new URL('./fixtures/glm-5.3-orphan-think.txt', import.meta.url), 'utf8');
  assert.throws(() => parseAction(output), { code: 'invalid' });
  assert.deepEqual(parseAction('<think>' + output), { action: 'count', filter: { type: 'Feature', status: 'open' } });
});

/** Use real SDK data for scope, Unicode, grouping and both deterministic extrema. */
test('v2 aggregates compute exact scoped observations and budgets', async t => {
  const { workspace, client } = await tracker(t);
  const a = (await client.create({ id: 'agg-a', title: 'é', priority: 1, type: 'Issue' })).item;
  const b = (await client.create({ id: 'agg-b', title: '🎉', priority: 3, type: 'Issue' })).item;
  await client.create({ id: 'agg-c', title: 'ab', priority: 1, type: 'Task' });
  const ctx = await createRlmContext({ workspace, scope: { type: 'Issue' }, budget: 100000 });
  const cases: [RlmAggregate, unknown][] = [
    [{ action: 'count', filter: {} }, 2],
    [{ action: 'sum', filter: {}, field_expr: 'len(title)' }, 6],
    [{ action: 'sum', filter: {}, field_expr: 'priority' }, 4],
    [{ action: 'distinct', filter: {}, field: 'priority' }, [1, 3]],
    [{ action: 'group_count', filter: {}, field: 'type' }, [{ value: 'Issue', count: 2 }]],
    [{ action: 'argmax', filter: {}, numeric_expr: 'len(title)' }, [b.id]],
    [{ action: 'argmin', filter: {}, numeric_expr: 'priority' }, [a.id]],
  ];
  for (const [action, expected] of cases) {
    assert.deepEqual(parseAction(JSON.stringify(action)), action);
    const before = ctx.remaining;
    const result = ctx.aggregate(action);
    assert.deepEqual(result.data, expected);
    assert.equal(result.estimated_tokens, estimateTokens(expected));
    assert.equal(ctx.remaining, before - result.estimated_tokens);
    assert.ok(result.complete_list);
  }
  assert.equal(ctx.aggregate({ action: 'count', filter: { type: 'Task' } }).data, 0);
  const tight = await createRlmContext({ workspace, budget: 0 });
  assert.throws(() => tight.aggregate(cases[0][0]), { code: 'budget' });
  assert.equal(tight.remaining, 0);
});

/** Verify grammar, empty sets, ties, missing values and numeric refusal boundaries. */
test('v2 aggregates refuse executable expressions and invalid field values', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ id: 'a', title: 'x', priority: 2 });
  await client.create({ id: 'b', title: 'x', priority: 2 });
  const items = (await readCorpus(workspace)).items;
  const raw = (value: Record<string, unknown>): RlmItem => ({ ...items[0], ...value });
  assert.equal(aggregateItems(items, { action: 'sum', filter: {}, field_expr: 'len(missing)' }), 0);
  assert.deepEqual(aggregateItems(items, { action: 'argmax', filter: {}, numeric_expr: 'priority' }), items.map(x => x.id).sort());
  assert.deepEqual(aggregateItems([], { action: 'argmin', filter: {}, numeric_expr: 'priority' }), []);
  assert.equal(aggregateItems([], { action: 'sum', filter: {}, field_expr: 'priority' }), 0);
  assert.equal(aggregateItems([raw({ title: undefined }), raw({ title: null })], { action: 'sum', filter: {}, field_expr: 'len(title)' }), 0);
  assert.deepEqual(aggregateItems([raw({ extra: true }), raw({ extra: false }), raw({ extra: null }), raw({ extra: undefined })], { action: 'distinct', filter: {}, field: 'extra' }), [false, null, true]);
  assert.deepEqual(aggregateItems(items, { action: 'group_count', filter: {}, field: 'missing' }), [{ value: null, count: 2 }]);
  for (const bad of ['len(title)+1', 'item.priority', 'len(len(title))', 'len(title', '__proto__.x', 'x()', '']) assert.throws(() => parseAggregate({ action: 'sum', field_expr: bad }), { code: 'invalid' });
  for (const bad of [{ action: 'wat' }, { action: 'distinct', field: 'x.y' }, { action: 'count', filter: { wrong: 'x' } }]) assert.throws(() => parseAggregate(bad), { code: 'invalid' });
  for (const value of [Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined, '1']) assert.throws(() => aggregateItems([raw({ priority: value })], { action: 'sum', filter: {}, field_expr: 'priority' }), { code: 'invalid' });
  assert.throws(() => aggregateItems([raw({ title: [] })], { action: 'sum', filter: {}, field_expr: 'len(title)' }), { code: 'invalid' });
  assert.throws(() => aggregateItems(items, { action: 'distinct', filter: {}, field: 'tags' }), { code: 'invalid' });
  assert.throws(() => aggregateItems([raw({ extra: Infinity })], { action: 'distinct', filter: {}, field: 'extra' }), { code: 'invalid' });
  assert.throws(() => aggregateItems([raw({ priority: Number.MAX_SAFE_INTEGER }), raw({ priority: 1 })], { action: 'sum', filter: {}, field_expr: 'priority' }), { code: 'invalid' });
  assert.deepEqual(aggregateItems([raw({ priority: 1.5 })], { action: 'argmin', filter: {}, numeric_expr: 'priority' }), [items[0].id]);
});

/** Refusals remain charged and corrective reasons reach the next prompt; replay uses the frozen snapshot. */
test('v2 ledger delivers aggregates and refusal reasons through replay and resume', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'é', type: 'Issue' })).item;
  const actions: RlmAggregate[] = [
    { action: 'count', filter: {} }, { action: 'sum', filter: {}, field_expr: 'len(title)' },
    { action: 'distinct', filter: {}, field: 'type' }, { action: 'group_count', filter: {}, field: 'type' },
    { action: 'argmax', filter: {}, numeric_expr: 'priority' }, { action: 'argmin', filter: {}, numeric_expr: 'priority' },
  ];
  const model = new ScriptedModel((request, index) => {
    if (index === 0) return '{"tool":"count"}';
    assert.match(request.prompt, /Action does not match the action JSON Schema/);
    return index <= actions.length ? JSON.stringify(actions[index - 1]) : '```json\n{"action":"finish","answer":"done"}\n```';
  });
  const result = await runRlm('Aggregate', { workspace, model, scope: { ids: [item.id] }, settings: { context_tokens: 131072, budget_tokens: 500000 } });
  const state = await new RlmLedger(workspace).load(result.run);
  assert.deepEqual(state.calls[0].steps[0].observation, { refused: 'invalid', reason: 'Action does not match the action JSON Schema' });
  assert.ok(state.calls[0].steps[0].reserved > 0);
  assert.equal(state.calls[0].steps.filter(step => typeof step.observation === 'object' && step.observation !== null && 'estimated_tokens' in step.observation).length, 6);
  await client.update(item.id, { title: 'Changed after snapshot' });
  assert.equal((await replayRlm(workspace, result.run)).answer, 'done');
  assert.equal((await resumeRlm(workspace, result.run, model)).answer, 'done');
  state.calls[0].steps[1].observation = { data: 99 };
  await new RlmLedger(workspace).save(state);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
});
