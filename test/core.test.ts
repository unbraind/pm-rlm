import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRlm, resumeRlm, replayRlm, treeRlm } from '../src/engine.ts';
import { createRlmContext, partitionItems } from '../src/environment.ts';
import { estimateTokens, RlmError } from '../src/errors.ts';
import { RlmLedger } from '../src/ledger.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Exercise the production SDK ledger from creation through read-only replay. */
test('real tracker runs, records evidence, closes calls and resumes completed results without inference', async t => {
  const { workspace, client } = await tracker(t);
  const issue = (await client.create({ title: 'Coverage issue', type: 'Issue', acceptanceCriteria: 'coverage' })).item;
  const model = new ScriptedModel((_request, index) => JSON.stringify(index === 0 ? { action: 'get', id: issue.id, fields: ['title'] } : { action: 'finish', answer: 'Exact answer\nwith bytes' }));
  const run = await runRlm('Inspect issue', { workspace, model });
  assert.equal(run.answer, 'Exact answer\nwith bytes');
  assert.equal(model.requests.length, 2);
  const state = await new RlmLedger(workspace).load(run.run);
  assert.equal(state.calls.length, 1);
  assert.equal((await client.get(run.run, { depth: 'full' })).item.status, 'closed');
  assert.equal((await replayRlm(workspace, run.run)).answer, run.answer);
  assert.deepEqual(await resumeRlm(workspace, run.run, model), run);
  assert.equal(model.requests.length, 2);
  assert.equal((await treeRlm(workspace, run.run)).run, run.run);
  assert.ok('state' in await treeRlm(workspace, run.run, true));
});

/** Exact read boundaries reject without partial delivery or spending a refused read. */
test('budget refuses one byte below exact boundary and succeeds at equality', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Boundary' })).item;
  const whole = await createRlmContext({ workspace, budget: 100000 });
  const projected = whole.get(item.id, ['title']).data;
  const required = estimateTokens(projected);
  const tight = await createRlmContext({ workspace, budget: required - 1 });
  assert.throws(() => tight.get(item.id, ['title']), (error: unknown) => error instanceof RlmError && error.code === 'budget');
  assert.equal(tight.remaining, required - 1);
  const exact = await createRlmContext({ workspace, budget: required });
  assert.equal(exact.get(item.id, ['title']).estimated_tokens, required);
  assert.equal(exact.remaining, 0);
});

/** Fragmentation is lossless even when a single item exceeds the slice limit. */
test('partition slices fit budget and reconstruct every byte', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Large', description: 'Text with escapes "\\ and Unicode 🎉 '.repeat(100) });
  const ctx = await createRlmContext({ workspace, budget: 100000 });
  const items = ctx.list().data;
  const slices = partitionItems(items, 300);
  assert.ok(slices.length > 1);
  assert.ok(slices.every(slice => slice.estimated_tokens === estimateTokens(slice.fragments) && slice.estimated_tokens <= 300));
  assert.equal(slices.flatMap(slice => slice.fragments).map(fragment => fragment.text).join(''), JSON.stringify(items[0]));
});
