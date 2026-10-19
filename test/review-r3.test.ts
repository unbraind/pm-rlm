import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { ACTION_SCHEMA, COMPATIBLE_ACTION_SCHEMA, COMPATIBLE_ACTION_WIRE_SCHEMA, COMPATIBLE_ANSWER_WIRE_SCHEMA, compatibleAction, schemaAction } from '../src/action-schema.ts';
import { HttpModel } from '../src/adapters.ts';
import { replayRlm, resumeRlm, runRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { parseAction } from '../src/protocol.ts';
import { readRlmSettings } from '../src/settings.ts';
import { ScriptedModel, tracker } from './helpers.ts';
import { httpFixture, requestBody } from './http.ts';

/** Audit every JSON key rather than just the known schema traversal paths. */
function auditWire(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['minLength', 'pattern', 'minimum', 'maximum'].includes(key), `Unsupported wire keyword: ${key}`);
    auditWire(child);
  }
}

/** Capture every durable item and append-only history byte in a real ledger. */
async function ledgerBytes(workspace: string): Promise<Record<string, string>> {
  const names = (await readdir(workspace, { recursive: true })).filter(name => /\.(toon|jsonl)$/.test(name)).sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, (await readFile(join(workspace, name))).toString('base64')])));
}

/** One endpoint-independent wire schema retains every constraint in local validation. */
test('review round 3 wire schema omits incompatible keywords and HTTP responses still refuse locally', async t => {
  auditWire(COMPATIBLE_ACTION_WIRE_SCHEMA);
  auditWire(COMPATIBLE_ANSWER_WIRE_SCHEMA);
  assert.notDeepEqual(COMPATIBLE_ACTION_WIRE_SCHEMA, COMPATIBLE_ACTION_SCHEMA);
  const validateWire = new Ajv({ strict: false }).compile(COMPATIBLE_ACTION_WIRE_SCHEMA);
  const validateLocal = new Ajv({ strict: false }).compile(ACTION_SCHEMA);
  const { workspace } = await tracker(t);
  let output = '';
  let received: Record<string, unknown> = {};
  const { endpoint } = await httpFixture(t, async (request, response) => {
    received = await requestBody(request);
    response.end(JSON.stringify({ choices: [{ message: { content: output } }] }));
  });
  process.env.RLM_REVIEW_WIRE_KEY = 'synthetic';
  t.after(() => { delete process.env.RLM_REVIEW_WIRE_KEY; });
  const model = new HttpModel(await readRlmSettings(workspace, { adapter: 'openai', endpoint, key_env: 'RLM_REVIEW_WIRE_KEY' }));
  for (const action of [
    { action: 'search', query: '', limit: 1 },
    { action: 'distinct', filter: null, field: 'bad.field' },
    { action: 'history', id: 'item', start: -1, end: 1 },
    { action: 'history', id: 'item', start: 0, end: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    output = JSON.stringify({ response: action });
    assert.equal(validateWire(JSON.parse(output)), true);
    const canonical = action.filter === null ? { ...action, filter: {} } : action;
    assert.equal(validateLocal(canonical), false);
    assert.throws(() => schemaAction(canonical), { code: 'invalid' });
    assert.throws(() => parseAction(compatibleAction(output)), { code: 'invalid' });
    const result = await model.complete({ prompt: 'Synthetic constraint check', max_output_tokens: 128, context_tokens: 8192 });
    assert.throws(() => parseAction(result.text), { code: 'invalid' });
    assert.deepEqual(received.response_format, { type: 'json_schema', json_schema: { name: 'action', strict: true, schema: COMPATIBLE_ACTION_WIRE_SCHEMA } });
  }
});

/** Recorded parse-refusal codes and messages must match before replay or resumed inference. */
test('review round 3 parse refusal tampering refuses replay and resume without ledger writes', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel((_request, index) => index === 0 ? '{"action":"search","query":"","limit":1}' : '{"action":"finish","answer":"exact\\n"}');
  const result = await runRlm('Synthetic parse refusal', { workspace, model });
  const ledger = new RlmLedger(workspace);
  const original = await ledger.load(result.run);
  const before = await ledgerBytes(workspace);
  assert.deepEqual(await replayRlm(workspace, result.run), result);
  assert.deepEqual(await ledgerBytes(workspace), before, 'Untampered replay preserves every durable ledger byte');
  const refusal = original.calls[0].steps[0].observation as { refused: string; reason: string };
  assert.equal(refusal.refused, 'invalid');
  assert.equal(refusal.reason, 'Action does not match the action JSON Schema');
  for (const unfinished of [false, true]) for (const observation of [
    { ...refusal, reason: 'Changed corrective text' },
    { ...refusal, refused: 'scope' },
    { refused: refusal.refused },
    null,
  ]) {
    const tampered = structuredClone(original);
    tampered.calls[0].steps[0].observation = observation;
    if (unfinished) {
      delete tampered.calls[0].result;
      tampered.calls[0].steps.pop();
    }
    await ledger.save(tampered);
    const bytes = await ledgerBytes(workspace);
    const expected = { code: 'replay', message: `Recorded parse refusal differs at step ${result.run}:0` };
    await assert.rejects(replayRlm(workspace, result.run), expected);
    const noInference = new ScriptedModel(() => assert.fail('Integrity refusal must precede inference'));
    await assert.rejects(resumeRlm(workspace, result.run, noInference), expected);
    assert.equal(noInference.requests.length, 0);
    assert.deepEqual(await ledgerBytes(workspace), bytes, 'Integrity refusals precede durable ledger writes');
  }
  const interrupted = structuredClone(original);
  delete interrupted.calls[0].result;
  interrupted.calls[0].steps.pop();
  await ledger.save(interrupted);
  const finish = new ScriptedModel(request => {
    assert.ok(request.prompt.includes(refusal.reason));
    return '{"action":"finish","answer":"recovered"}';
  });
  assert.equal((await resumeRlm(workspace, result.run, finish)).answer, 'recovered');
  const recovered = await ledgerBytes(workspace);
  assert.equal((await replayRlm(workspace, result.run)).answer, 'recovered');
  assert.deepEqual(await ledgerBytes(workspace), recovered);
});

/** Original v1 checkpoints lack reasons; verify their codes and any reasons they do contain. */
test('review round 3 legacy code-only receipts replay unchanged and recorded reasons remain checked', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel((_request, index) => index === 0 ? '{' : '{"action":"finish","answer":"legacy"}');
  const result = await runRlm('Synthetic legacy refusal', { workspace, model });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(result.run);
  for (const version of [undefined, 1] as const) {
    if (version === undefined) delete state.parser_version; else state.parser_version = version;
    state.calls[0].steps[0].observation = { refused: 'invalid' };
    await ledger.save(state);
    const bytes = await ledgerBytes(workspace);
    assert.deepEqual(await replayRlm(workspace, result.run), result);
    assert.deepEqual(await ledgerBytes(workspace), bytes);
    for (const observation of [
      { refused: 'invalid', reason: 'Model output is not valid JSON' },
      { refused: 'invalid', reason: 'Changed legacy reason' },
      { refused: 'scope' },
    ]) {
      state.calls[0].steps[0].observation = observation;
      await ledger.save(state);
      if (observation.reason === 'Model output is not valid JSON') {
        assert.deepEqual(await replayRlm(workspace, result.run), result);
        assert.deepEqual(await resumeRlm(workspace, result.run, model), result);
      } else {
        await assert.rejects(replayRlm(workspace, result.run), { code: 'replay' });
        await assert.rejects(resumeRlm(workspace, result.run, model), { code: 'replay' });
      }
    }
  }
});
