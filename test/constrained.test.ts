import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACTION_SCHEMA, ANSWER_SCHEMA, COMPATIBLE_ACTION_SCHEMA, COMPATIBLE_ANSWER_SCHEMA, acceptsSchema, compatibleAction } from '../src/action-schema.ts';
import { Ajv } from 'ajv';
import { publicSource } from './live.ts';
import { estimateTokens, RlmError } from '../src/errors.ts';
import type { ActionSchema } from '../src/action-schema.ts';
import { parseAction, PROTOCOL } from '../src/protocol.ts';
import { runRlm, replayRlm, resumeRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Exercise every alternative and mutate its fields across JSON types and unsafe integers. */
test('constrained schema and action validator agree on all alternatives and invalid operands', () => {
  const validate = new Ajv({ strict: false }).compile(ACTION_SCHEMA);
  const actions = [
    { action: 'list', filter: { type: 'Issue', status: 'open', parent: 'parent', tag: 'x', text: 'é', ids: ['a'] } },
    { action: 'search', query: 'x', limit: 1 }, { action: 'get', id: 'a', fields: ['title'] },
    { action: 'history', id: 'a', start: 0, end: 2 }, { action: 'peek', id: 'a', field: 'description', start: 0, end: 2 },
    { action: 'partition', filter: {}, maxTokens: 500 }, { action: 'spawn', subgoal: 'q', slice: { partition_step: 0, index: 0 } },
    { action: 'spawn', subgoal: 'q', slice: { fragments: [{ id: 'a', start: 0, end: 1, text: 'x' }], estimated_tokens: estimateTokens([{ id: 'a', start: 0, end: 1, text: 'x' }]) } },
    { action: 'finish', answer: '' }, { action: 'count' }, { action: 'sum', filter: {}, field_expr: 'len(title)' },
    { action: 'distinct', filter: {}, field: 'status' }, { action: 'group_count', filter: {}, field: 'type' },
    { action: 'argmax', filter: {}, numeric_expr: 'priority' }, { action: 'argmin', filter: {}, numeric_expr: 'len(description)' },
  ];
  for (const action of actions) {
    assert.equal(validate(action), true);
    assert.equal(acceptsSchema(ACTION_SCHEMA, action), true);
    assert.equal(parseAction(JSON.stringify(action), 2).action, action.action);
    if (!['count', 'sum', 'distinct', 'group_count', 'argmax', 'argmin'].includes(action.action)) assert.equal(parseAction(JSON.stringify(action), 1).action, action.action);
    assert.equal(parseAction(JSON.stringify(action)).action, action.action);
    for (const key of Object.keys(action)) for (const value of [null, false, [], {}, '', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'bad.field', 'x()']) {
      const mutated = { ...action, [key]: value };
      assert.equal(acceptsSchema(ACTION_SCHEMA, mutated), Boolean(validate(mutated)));
      assert.equal(acceptsSchema(ACTION_SCHEMA, mutated), (() => { try { parseAction(JSON.stringify(mutated)); return true; } catch { return false; } })());
    }
  }
  for (const value of [[], null, {}, { action: 'list', filter: { typo: 'x' } }, { action: 'finish', answer: 'x', extra: true }]) assert.equal(acceptsSchema(ACTION_SCHEMA, value), false);
  assert.throws(() => parseAction('{"action":"get","id":"a"}', 2));
  assert.throws(() => parseAction('{"action":"unknown"}', 2));
  assert.throws(() => parseAction('{"action":"finish","answer":1}', 2));
  assert.equal(acceptsSchema({}, 'x'), false);
  assert.equal(acceptsSchema({ type: 'null' }, null), true);
  assert.equal(acceptsSchema({ type: 'null' }, false), false);
  assert.equal(acceptsSchema(ANSWER_SCHEMA, { answer: 'x' }), true);
  assert.equal(acceptsSchema(COMPATIBLE_ANSWER_SCHEMA, { answer: 'x' }), true);
});

/** Strict compatible transport needs a root object and required nullable optional fields. */
test('constrained compatible action wrapping strips only optional nulls and keeps the fallback', () => {
  /** Audit the provider's strict-object requirements independently of our generator. */
  function audit(schema: ActionSchema): void {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required?.slice().sort(), Object.keys(schema.properties ?? {}).sort());
    }
    for (const child of Object.values(schema.properties ?? {})) audit(child);
    for (const child of schema.anyOf ?? []) audit(child);
    if (schema.items !== undefined) audit(schema.items);
  }
  audit(COMPATIBLE_ACTION_SCHEMA); audit(COMPATIBLE_ANSWER_SCHEMA);
  const count = { response: { action: 'count', filter: { type: null, status: 'open', parent: null, tag: null, text: null, ids: null } } };
  assert.equal(acceptsSchema(COMPATIBLE_ACTION_SCHEMA, count), true);
  assert.deepEqual(JSON.parse(compatibleAction(JSON.stringify(count))), { action: 'count', filter: { status: 'open' } });
  assert.deepEqual(JSON.parse(compatibleAction('{"response":{"action":"count","filter":null}}')), { action: 'count' });
  assert.equal(compatibleAction('{"response":{"action":"finish","answer":"x"}}'), '{"action":"finish","answer":"x"}');
  assert.equal(compatibleAction('{"response":{"action":"get","id":"a","fields":["title"]}}'), '{"action":"get","id":"a","fields":["title"]}');
  for (const output of ['```json\n{"action":"count"}\n```', '{"action":"count"}', '{"response":{"action":"count","filter":{"unknown":null}}}', 'null']) assert.equal(compatibleAction(output), output);
});

/** Raw duplicate keys must survive transport normalization for the canonical refusal. */
test('constrained wrapped duplicate keys refuse at every nesting level', () => {
  for (const output of [
    '{"response":{"action":"finish","answer":"a"},"response":{"action":"finish","answer":"b"}}',
    '{"response":{"action":"finish","answer":"a","answer":"b"}}',
    '{"response":{"action":"count","filter":{"type":null,"status":"open","status":"closed","parent":null,"tag":null,"text":null,"ids":null}}}',
    '{"response":{"action":"spawn","subgoal":"q","slice":{"fragments":[{"id":"a","id":"b","start":0,"end":1,"text":"x"}],"estimated_tokens":1}}}',
    '{"response":{"action":"finish","answer":"a","\\u0061nswer":"b"}}',
  ]) {
    assert.equal(compatibleAction(output), output);
    assert.throws(() => parseAction(compatibleAction(output)), new RlmError('invalid', 'Ambiguous duplicate JSON key'));
  }
  const valid = '{"response":{"action":"finish","answer":"a"}}';
  assert.deepEqual(parseAction(compatibleAction(valid)), { action: 'finish', answer: 'a' });
  const siblings = '{"response":{"action":"spawn","subgoal":"q","slice":{"fragments":[{"id":"a","start":0,"end":1,"text":"x"},{"id":"b","start":0,"end":1,"text":"y"}],"estimated_tokens":1}}}';
  assert.equal(parseAction(compatibleAction(siblings)).action, 'spawn');
});

/** Keep malformed wrapped responses billable and deliver the established correction reason. */
test('constrained wrapped duplicate refusal reaches the next prompt and replays', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel((request, index) => {
    if (index === 0) return compatibleAction('{"response":{"action":"finish","answer":"a","answer":"b"}}');
    assert.match(request.prompt, /Ambiguous duplicate JSON key/);
    return compatibleAction('{"response":{"action":"finish","answer":"corrected"}}');
  });
  const result = await runRlm('Wrapped correction', { workspace, model });
  assert.equal(result.answer, 'corrected');
  const state = await new RlmLedger(workspace).load(result.run);
  assert.deepEqual(state.calls[0].steps[0].observation, { refused: 'invalid', reason: 'Ambiguous duplicate JSON key' });
  assert.ok(state.calls[0].steps[0].reserved > 0);
  assert.deepEqual(await replayRlm(workspace, result.run), result);
});

/** An unchanged strict checkpoint with a fenced refused spawn must replay without any writes. */
test('parser versions preserve strict checkpoints byte for byte on replay and strict resume', async t => {
  const { workspace, client } = await tracker(t);
  const model = new ScriptedModel(() => '{"action":"finish","answer":"legacy exact\\n"}');
  const result = await runRlm('legacy checkpoint', { workspace, model });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(result.run);
  assert.equal(state.parser_version, 3);
  const finish = structuredClone(state.calls[0].steps[0]);
  const fenced = '```json\n{"action":"spawn","subgoal":"child","slice":{"partition_step":99,"index":0}}\n```';
  for (const version of [undefined, 1] as const) {
    const legacy = structuredClone(state);
    if (version === undefined) delete legacy.parser_version; else legacy.parser_version = version;
    legacy.calls[0].steps.unshift({ prompt: 'legacy prompt', reserved: 0, settled: true, response: { text: fenced, tokens_in: 0, tokens_out: 0 }, observation: { refused: 'invalid' } });
    await ledger.save(legacy);
    const before = (await client.get(result.run, { depth: 'full' })).item.rlm_state;
    assert.deepEqual(await replayRlm(workspace, result.run), result);
    assert.equal((await client.get(result.run, { depth: 'full' })).item.rlm_state, before);
    delete legacy.calls[0].result;
    legacy.calls[0].steps.pop();
    legacy.calls[0].steps.push({ ...finish, response: { text: fenced, tokens_in: 0, tokens_out: 0 } });
    await ledger.save(legacy);
    const resumed = new ScriptedModel(request => {
      assert.equal(request.parser_version, 1);
      assert.match(request.prompt, /Model output is not valid JSON/);
      return '{"action":"finish","answer":"legacy exact\\n"}';
    });
    assert.equal((await resumeRlm(workspace, result.run, resumed)).answer, result.answer);
    assert.equal((await ledger.load(result.run)).calls[0].steps[1].observation !== undefined, true);
  }
  const invalid = { ...state, parser_version: '3' };
  await client.run('update', { id: result.run, options: { rlmState: JSON.stringify(invalid) } });
  await assert.rejects(ledger.load(result.run), { code: 'incomplete' });
  assert.throws(() => parseAction('{"action":"count"}', 1), { code: 'invalid' });
  assert.equal(parseAction('```json\n{"action":"count"}\n```', 2).action, 'count');
  assert.equal(parseAction('{"action":"list"}', 1).action, 'list');
  assert.deepEqual(parseAction('{"action":"partition","maxTokens":100}', 1), { action: 'partition', filter: {}, maxTokens: 100 });
});

/** URL path conversion survives spaces, Unicode and percent-escaped names. */
test('live source URL converts escaped checkout paths to filesystem paths', () => {
  const base = pathToFileURL(resolve('workspace/package space % é/worktrees/pm-rlm-v2/test/live-v2.ts'));
  assert.equal(publicSource('pm-vcs', base.href), fileURLToPath(new URL('../../../fleet/pm-vcs/', base)));
  assert.ok(publicSource('pm-vcs', base.href).includes('package space % é'));
  assert.ok(publicSource('pm-vcs').endsWith(join('fleet', 'pm-vcs') + sep));
});

/** Successful partition references in unversioned checkpoints retain the v1 parser too. */
test('legacy partition references replay with the original strict parser', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Legacy partition' });
  const model = new ScriptedModel(request => {
    const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { depth: number; transcript: unknown[] };
    if (input.depth > 0 || input.transcript.length > 1) return '{"action":"finish","answer":"ok"}';
    return JSON.stringify(input.transcript.length === 0 ? { action: 'partition', maxTokens: 10000 } : { action: 'spawn', subgoal: 'child', slice: { partition_step: 0, index: 0 } });
  });
  const run = await runRlm('legacy partitions', { workspace, model });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(run.run);
  delete state.parser_version;
  await ledger.save(state);
  assert.deepEqual(await replayRlm(workspace, run.run), run);
});
