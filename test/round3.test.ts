import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { HttpModel } from '../src/adapters.ts';
import { readRlmSettings } from '../src/settings.ts';
import { runRlm, replayRlm, resumeRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { tracker, ScriptedModel } from './helpers.ts';
import { httpFixture } from './http.ts';

/** Redirects cannot forward workspace prompts to a second origin, with or without credentials. */
test('model endpoints reject redirects before any destination receives a prompt', async t => {
  const { workspace } = await tracker(t);
  let received = 0;
  const destination = await httpFixture(t, (_request, response) => { received++; response.end('{"response":"ok","choices":[{"message":{"content":"ok"}}]}'); });
  let status = 307;
  const { endpoint } = await httpFixture(t, (_request, response) => { response.writeHead(status, { Location: destination.endpoint }); response.end(); });
  const key = 'RLM_REDIRECT_TEST_KEY'; const before = process.env[key]; process.env[key] = 'synthetic-credential';
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  for (const adapter of ['ollama', 'openai'] as const) for (const code of [307, 308]) {
    status = code;
    const model = new HttpModel(await readRlmSettings(workspace, { endpoint, adapter, key_env: key }));
    await assert.rejects(model.complete({ prompt: 'private workspace fixture', context_tokens: 32768, max_output_tokens: 512 }), { code: 'model' });
  }
  assert.equal(received, 0);
});

/** Streaming rejected bodies are released promptly, before server-side completion or garbage collection. */
test('non-OK streaming bodies are canceled promptly', async t => {
  const { workspace } = await tracker(t);
  let closed: Promise<unknown[]> | undefined;
  let bodyless = false;
  const { endpoint } = await httpFixture(t, (_request, response) => {
    response.writeHead(bodyless ? 304 : 503);
    if (bodyless) { response.end(); return; }
    closed = once(response, 'close');
    response.write('never-ending rejected response');
  });
  const model = new HttpModel(await readRlmSettings(workspace, { endpoint }));
  const request = { prompt: 'fixture', context_tokens: 32768, max_output_tokens: 512 };
  await assert.rejects(model.complete(request), { code: 'model', message: 'Model endpoint refused the request' });
  assert.ok(closed);
  const ended = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), 1000); timer.unref(); })]);
  assert.equal(ended, true);
  bodyless = true;
  await assert.rejects(model.complete(request), { code: 'model', message: 'Model endpoint refused the request' });
});

/** Interrupted or malformed spawn observations refuse replay with its documented typed error. */
test('replay refuses absent or malformed spawn observations with a typed replay code', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel((_request, index) => index === 0 ? '{"action":"spawn","subgoal":"child","slice":{"fragments":[],"estimated_tokens":2}}' : '{"action":"finish","answer":"ok"}');
  const result = await runRlm('spawn', { workspace, model });
  const ledger = new RlmLedger(workspace); const original = await ledger.load(result.run);
  for (const observation of [undefined, null, 'bad', {}, { result: 1 }]) {
    const state = structuredClone(original); state.calls[0].steps[0].observation = observation;
    await ledger.save(state);
    await assert.rejects(replayRlm(workspace, result.run), { code: 'replay', message: 'Recorded spawn step has no completed observation' });
  }
  await ledger.save(original);
  assert.equal((await resumeRlm(workspace, result.run, model)).answer, 'ok');
});
