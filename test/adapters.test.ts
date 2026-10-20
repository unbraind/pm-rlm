import { randomUUID } from 'node:crypto';
import { httpFixture, requestBody } from './http.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTION_SCHEMA, ANSWER_SCHEMA, COMPATIBLE_ACTION_WIRE_SCHEMA, COMPATIBLE_ANSWER_WIRE_SCHEMA } from '../src/action-schema.ts';
import { HttpModel } from '../src/adapters.ts';
import { readRlmSettings, writeRlmSettings } from '../src/settings.ts';
import { parseAction, parseSlice } from '../src/protocol.ts';
import { estimateTokens } from '../src/errors.ts';
import { tracker } from './helpers.ts';

/** Exercise actual HTTP wire protocols, malformed responses, credentials and bounded failures. */
test('HTTP adapters use real endpoints, transient env credentials and provider usage', async t => {
  const { workspace } = await tracker(t);
  let payload: unknown = { response: '{"action":"finish","answer":"ok"}', prompt_eval_count: 10, eval_count: 5 };
  let status = 200;
  let authorization: string | undefined;
  let received: Record<string, unknown> = {};
  const { server, endpoint } = await httpFixture(t, async (request, response) => {
    authorization = request.headers.authorization;
    received = await requestBody(request);
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
  });
  const config = await readRlmSettings(workspace, { endpoint: endpoint, key_env: 'RLM_ADAPTER_TEST_KEY' });
  const request = { prompt: 'prompt', max_output_tokens: 64, context_tokens: 8192 };
  const local = new HttpModel(config);
  assert.deepEqual(await local.complete(request), { text: '{"action":"finish","answer":"ok"}', tokens_in: 10, tokens_out: 5 });
  assert.equal(authorization, undefined); assert.equal(received.stream, false); assert.equal(local.name, config.model);
  assert.deepEqual(received.format, ACTION_SCHEMA);
  payload = { response: 'output' };
  assert.deepEqual(await local.complete(request), { text: 'output', tokens_in: 6, tokens_out: 6 });
  const compatible = new HttpModel({ ...config, adapter: 'openai', endpoint: config.endpoint + '/' });
  delete process.env.RLM_ADAPTER_TEST_KEY;
  await assert.rejects(compatible.complete(request), { code: 'model' });
  const privateKey = randomUUID();
  process.env.RLM_ADAPTER_TEST_KEY = privateKey;
  t.after(() => { delete process.env.RLM_ADAPTER_TEST_KEY; });
  payload = { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 11, completion_tokens: 2 } };
  assert.deepEqual(await compatible.complete(request), { text: 'ok', tokens_in: 11, tokens_out: 2 });
  assert.equal(authorization, `Bearer ${privateKey}`);
  assert.equal(received.max_tokens, 64);
  assert.deepEqual(received.response_format, { type: 'json_schema', json_schema: { name: 'action', strict: true, schema: COMPATIBLE_ACTION_WIRE_SCHEMA } });
  payload = { choices: [{ message: { content: '{"response":{"action":"count","filter":null}}' } }] };
  assert.equal((await compatible.complete(request)).text, '{"action":"count"}');
  await compatible.complete({ ...request, response_kind: 'answer' });
  assert.deepEqual(received.response_format, { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: COMPATIBLE_ANSWER_WIRE_SCHEMA } });
  await compatible.complete({ ...request, parser_version: 1 });
  assert.equal(received.response_format, undefined);
  payload = { response: 'answer' };
  await local.complete({ ...request, response_kind: 'answer' });
  assert.deepEqual(received.format, ANSWER_SCHEMA);
  await local.complete({ ...request, parser_version: 2 });
  assert.equal(received.format, 'json');
  payload = { choices: [{ message: { content: 'fallback' } }] };
  assert.equal((await compatible.complete(request)).tokens_out, 8);
  for (const bad of [{}, { choices: [] }, { choices: [null] }, { choices: [{ message: { content: '' } }] }, { choices: [{ message: { content: 'x'.repeat(1100) } }] }, { choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: -1 } }]) {
    payload = bad; await assert.rejects(compatible.complete(request), error => error instanceof Error && /Model response has no choices|Expected a JSON object|Expected nonempty text|Model output exceeds transport allowance|Expected a bounded integer/.test(error.message));
  }
  status = 500; await assert.rejects(local.complete(request), { code: 'model', message: 'Model endpoint refused the request' });
  server.close(); server.closeAllConnections();
  await assert.rejects(local.complete(request), { code: 'model' });
});

/** Audit settings mutation, precedence, known-key validation and strict transport configuration. */
test('settings defaults, audited persistence, overrides and invalid configurations', async t => {
  const { workspace } = await tracker(t);
  const defaults = await readRlmSettings(workspace);
  assert.equal(defaults.model, 'gemma4:e4b');
  const saved = await writeRlmSettings(workspace, { model: 'local-test', budget_tokens: 50000 }, 'rlm-test');
  assert.equal((await readRlmSettings(workspace)).model, 'local-test');
  assert.equal((await readRlmSettings(workspace, { model: 'override' })).model, 'override');
  assert.equal(saved.budget_tokens, 50000);
  for (const overrides of [{ adapter: 'invalid' }, { model: '' }, { endpoint: 'file:invalid' }, { endpoint: 'https://name:password@example.invalid' }, { endpoint: 'https://example.invalid?q=x' }, { endpoint: 'https://example.invalid#x' }, { key_env: 'not-an-env' }, { max_depth: 33 }, { max_calls: 0 }, { output_tokens: 32768 }]) await assert.rejects(readRlmSettings(workspace, overrides as never));
});

/** All protocol alternatives have typed validation rather than unchecked model arguments. */
test('protocol parses supported actions and refuses invalid JSON, names, ranges, fields and slices', () => {
  for (const action of [
    { action: 'list' }, { action: 'search', query: 'x', limit: 1 }, { action: 'get', id: 'x', fields: ['title'] },
    { action: 'history', id: 'x', start: 0, end: 2 }, { action: 'peek', id: 'x', field: 'body', start: 0, end: 2 },
    { action: 'partition', maxTokens: 100 }, { action: 'spawn', subgoal: 'q', slice: { fragments: [], estimated_tokens: 2 } }, { action: 'finish', answer: '' },
  ]) assert.equal(parseAction(JSON.stringify(action)).action, action.action);
  for (const bad of ['{', 'null', '{"action":"unknown"}', '{"action":"get","id":"x"}', '{"action":"finish","answer":4}']) assert.throws(() => parseAction(bad));
  const fragments = [{ id: 'x', start: 0, end: 1, text: 'a' }];
  assert.deepEqual(parseSlice({ fragments, estimated_tokens: estimateTokens(fragments) }).fragments, fragments);
  for (const bad of [{}, { fragments }, { fragments: [{ id: 'x', start: 0, end: 3, text: 'a' }], estimated_tokens: 1 }]) assert.throws(() => parseSlice(bad));
});
