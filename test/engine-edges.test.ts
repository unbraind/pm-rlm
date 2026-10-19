import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runRlm, resumeRlm, replayRlm, RlmEngine } from '../src/engine.ts';
import { RlmLedger, promptDigest } from '../src/ledger.ts';
import { estimateTokens } from '../src/errors.ts';
import { PROTOCOL } from '../src/protocol.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Drive every read action through live execution and then replay the observations. */
test('model loop executes all read actions, records billable JSON refusals, and replays reads', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Read actions', description: 'abcdef' })).item;
  const outputs = ['{', '{"action":"unknown"}', ...[
    { action: 'list' }, { action: 'search', query: 'Read', limit: 1 }, { action: 'get', id: item.id, fields: ['title'] },
    { action: 'history', id: item.id, start: 0, end: 1 }, { action: 'peek', id: item.id, field: 'description', start: 0, end: 3 },
    { action: 'partition', filter: {}, maxTokens: 1000 }, { action: 'finish', answer: 'reads complete' },
  ].map(value => JSON.stringify(value))];
  const model = new ScriptedModel((_request, index) => outputs[index]);
  const result = await runRlm('Exercise every read', { workspace, model, settings: { context_tokens: 50000, budget_tokens: 500000 } });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(result.run);
  assert.partialDeepStrictEqual(state.calls[0].steps[0].observation, { refused: 'invalid' });
  assert.ok(state.reserved_tokens > state.calls[0].steps[0].reserved * 2);
  assert.equal((await replayRlm(workspace, result.run)).answer, 'reads complete');
  await assert.rejects(resumeRlm(workspace, result.run, { ...model, name: 'wrong', complete: request => model.complete(request) }), { code: 'invalid' });
  state.calls[0].steps[2].observation = { data: [] };
  await ledger.save(state);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
});

/** Privacy refusal leaves credentials and absolute scratch paths out of every ledger and history record. */
test('privacy rejects source paths and model credential echoes before persistence', async t => {
  const { workspace, root, client } = await tracker(t);
  const variable = 'RLM_PRIVACY_TEST_KEY'; process.env[variable] = randomUUID();
  t.after(() => { delete process.env[variable]; });
  await assert.rejects(runRlm(workspace, { workspace, settings: { key_env: variable }, model: new ScriptedModel(() => '') }), { code: 'invalid' });
  const model = new ScriptedModel(() => JSON.stringify({ action: 'finish', answer: process.env[variable] }));
  await assert.rejects(runRlm('no secrets', { workspace, settings: { key_env: variable }, model }), { code: 'invalid' });
  const rows = (await client.listAllComplete()).items;
  const run = rows.find(item => typeof item.rlm_state === 'string')!;
  assert.equal(JSON.stringify(rows).includes(process.env[variable]!), false);
  assert.equal(JSON.stringify(rows).includes(root), false);
  const history = await readFile(join(workspace, 'history', `${run.id}.jsonl`), 'utf8');
  assert.equal(history.includes(process.env[variable]!), false);
});

/** Process leases are exclusive, recover dead owners, and never delete another owner's token. */
test('lease exclusion and dead-process recovery use real runtime files and SDK locks', async t => {
  const { workspace } = await tracker(t);
  const ledger = new RlmLedger(workspace);
  await assert.rejects(ledger.lease('../invalid'), { code: 'invalid' });
  const release = await ledger.lease('run');
  await assert.rejects(ledger.lease('run'), { code: 'busy' });
  await release(); await release();
  const path = join(workspace, 'runtime', 'rlm-run.json');
  await writeFile(path, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  const recovered = await ledger.lease('run');
  await writeFile(path, JSON.stringify({ pid: process.pid, token: 'changed' }));
  await recovered(); assert.ok(await readFile(path));
  await rm(path);
});

/** Sub-call slices cannot smuggle fields outside their inherited environment. */
test('full and partial inherited slices retain safe child scope', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Scoped', description: 'content' })).item;
  const model = new ScriptedModel(() => '{"action":"finish","answer":"ok"}');
  const run = await runRlm('scopes', { workspace, model });
  const ledger = new RlmLedger(workspace); const state = await ledger.load(run.run);
  const engine = new RlmEngine(ledger, state, model);
  const data = JSON.stringify(state.snapshot[0]);
  const fragments = [{ id: item.id, start: 0, end: data.length, text: data }];
  const slice = { fragments, estimated_tokens: estimateTokens(fragments) };
  await engine.spawn(state.run, 'full', slice);
  const child = state.calls[1];
  const partial = [{ id: item.id, start: 0, end: 10, text: data.slice(0, 10) }];
  await engine.spawn(child.id, 'partial', { fragments: partial, estimated_tokens: estimateTokens(partial) });
  const partialCall = state.calls[2];
  await engine.spawn(partialCall.id, 'inherited', { fragments: partial, estimated_tokens: estimateTokens(partial) });
  assert.equal(state.calls[3].depth, 3);
  const before = state.calls.length;
  const invalid = [{ ...fragments[0], text: 'x'.repeat(data.length) }];
  await assert.rejects(engine.spawn(state.run, 'invalid', { fragments: invalid, estimated_tokens: estimateTokens(invalid) }), { code: 'scope' });
  assert.equal(state.calls.length, before);
  assert.equal(promptDigest('a', slice, state.settings), promptDigest('a', slice, state.settings));
});

/** Recorded answers and graph membership are checked by replay, including unfinished runs. */
test('replay refuses altered finish outputs and orphaned calls', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel(() => '{"action":"finish","answer":"ok"}');
  const result = await runRlm('replay', { workspace, model });
  const ledger = new RlmLedger(workspace); const original = await ledger.load(result.run);
  const changed = structuredClone(original); changed.calls[0].result = 'wrong'; await ledger.save(changed);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
  const unfinished = structuredClone(original); unfinished.calls[0].steps = []; delete unfinished.calls[0].result; await ledger.save(unfinished);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
  const orphan = structuredClone(original); orphan.calls.push({ ...orphan.calls[0], id: 'orphan' }); await ledger.save(orphan);
  await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
  await ledger.save(original);
  assert.ok(PROTOCOL.includes('finish'));
});

/** Multiple fragments grant item tools only when they cover the complete original JSON without a gap. */
test('child item reads require contiguous complete multi-fragment coverage', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Fragment scope' })).item;
  const model = new ScriptedModel(request => {
    const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { transcript: { observation: { data: unknown[] } }[] };
    return JSON.stringify(input.transcript.length === 0 ? { action: 'list' } : { action: 'finish', answer: String(input.transcript[0].observation.data.length) });
  });
  const run = await runRlm('root fragment scope', { workspace, model });
  const ledger = new RlmLedger(workspace); const state = await ledger.load(run.run);
  const engine = new RlmEngine(ledger, state, model);
  const source = JSON.stringify(state.snapshot[0]); const middle = Math.floor(source.length / 2);
  const first = { id: item.id, start: 0, end: middle, text: source.slice(0, middle) };
  const second = { id: item.id, start: middle, end: source.length, text: source.slice(middle) };
  const complete = [first, second];
  assert.equal(await engine.spawn(state.run, 'contiguous', { fragments: complete, estimated_tokens: estimateTokens(complete) }), '1');
  const incomplete = [first, { ...second, start: middle + 1, text: source.slice(middle + 1) }];
  assert.equal(await engine.spawn(state.run, 'gap', { fragments: incomplete, estimated_tokens: estimateTokens(incomplete) }), '0');
});
