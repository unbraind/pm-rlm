import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHistoryPath, getSettingsPath } from '@unbrained/pm-cli/sdk';
import { createRlmContext, readCorpus } from '../src/environment.ts';
import { estimateTokens, RlmError } from '../src/errors.ts';
import { RlmLedger } from '../src/ledger.ts';
import { readRlmSettings } from '../src/settings.ts';
import { runRlm, resumeRlm, replayRlm } from '../src/engine.ts';
import { PROTOCOL } from '../src/protocol.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Read failures remain typed and sanitized when genuine on-disk SDK inputs are broken. */
test('SDK read boundaries sanitize corrupt history corpus settings and lease files', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'History source' })).item;
  const context = await createRlmContext({ workspace, budget: 100000 });
  const history = getHistoryPath(workspace, item.id);
  const original = await readFile(history);
  for (const content of ['invalid-history-json', '', '{"broken":true}\n']) {
    await writeFile(history, content);
    await assert.rejects(context.history(item.id, { start: 0, end: 2 }), error => {
      assert.ok(error instanceof RlmError); assert.equal(error.code, 'incomplete'); assert.ok(!error.message.includes(workspace)); return true;
    });
  }
  await writeFile(history, original);
  const run = await runRlm('read boundaries', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"ok"}') });
  const ledger = new RlmLedger(workspace); const state = await ledger.load(run.run);
  await mkdir(join(workspace, 'tasks', 'unreadable.toon'));
  for (const operation of [() => readCorpus(workspace), () => ledger.load(run.run), () => ledger.materialize(state, state.calls[0]), () => ledger.complete(state, state.calls[0])]) await assert.rejects(operation(), { code: 'incomplete' });
  await rm(join(workspace, 'tasks', 'unreadable.toon'), { recursive: true });
  const settings = getSettingsPath(workspace); const before = await readFile(settings);
  await writeFile(settings, '{'); await assert.rejects(readRlmSettings(workspace), { code: 'incomplete' });
  await writeFile(settings, before);
  const path = join(workspace, 'runtime', 'rlm-corrupt.json');
  await writeFile(path, '{'); await assert.rejects(ledger.lease('corrupt'), { code: 'incomplete' });
  await rm(path);
  const release = await ledger.lease('corrupt');
  await writeFile(path, '{'); await assert.rejects(release(), { code: 'incomplete' });
});

/** History parsing is a recoverable tool refusal inside a child, with resumable terminal evidence. */
test('malformed child history produces a recorded incomplete refusal without stranding calls', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'Child history' })).item;
  await writeFile(getHistoryPath(workspace, item.id), 'invalid-history-json');
  const corpus = await readCorpus(workspace); const source = JSON.stringify(corpus.items[0]);
  const fragments = [{ id: item.id, start: 0, end: source.length, text: source }];
  const rootModel = new ScriptedModel(request => {
    const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { question: string; transcript: { observation?: { refused?: string } }[] };
    if (input.question === 'child' && input.transcript.length === 0) return JSON.stringify({ action: 'history', id: item.id, start: 0, end: 1 });
    if (input.question === 'child') { assert.equal(input.transcript[0].observation?.refused, 'incomplete'); return '{"action":"finish","answer":"child recovered"}'; }
    return JSON.stringify(input.transcript.length === 0 ? { action: 'spawn', subgoal: 'child', slice: { fragments, estimated_tokens: estimateTokens(fragments) } } : { action: 'finish', answer: 'root recovered' });
  });
  const result = await runRlm('root', { workspace, model: rootModel }).catch(() => assert.fail('Malformed child history must be a recoverable tool refusal'));
  assert.equal(result.answer, 'root recovered');
  const state = await new RlmLedger(workspace).load(result.run);
  assert.equal(state.calls.length, 2); assert.ok(state.calls.every(call => call.result !== undefined));
  assert.deepEqual(state.calls[1].steps[0].observation, { refused: 'incomplete' });
  for (const call of state.calls) assert.equal((await client.get(call.id, { depth: 'full' })).item.status, 'closed');
  const count = rootModel.requests.length;
  assert.equal((await resumeRlm(workspace, result.run, rootModel)).answer, result.answer);
  assert.equal((await replayRlm(workspace, result.run)).answer, result.answer);
  assert.equal(rootModel.requests.length, count);
});

/** Evidence mutations are fatal until repaired, while completed child inference remains reusable. */
test('failed child evidence writes cannot become a successful parent tool refusal', async t => {
  const { workspace, client } = await tracker(t);
  let path = ''; let original = Buffer.alloc(0); let childRequests = 0;
  const model = new ScriptedModel(async request => {
    const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { question: string; transcript: unknown[] };
    if (input.question === 'child') {
      childRequests++;
      const row = (await client.listAllComplete()).items.find(item => item.rlm_depth === 1)!;
      path = getHistoryPath(workspace, row.id); original = await readFile(path);
      await rm(path); await mkdir(path);
      return '{"action":"finish","answer":"child"}';
    }
    return JSON.stringify(input.transcript.length === 0 ? { action: 'spawn', subgoal: 'child', slice: { fragments: [], estimated_tokens: 2 } } : { action: 'finish', answer: 'root' });
  });
  await assert.rejects(runRlm('root', { workspace, model }));
  const root = (await client.listAllComplete()).items.find(item => typeof item.rlm_state === 'string')!;
  const ledger = new RlmLedger(workspace); const pending = await ledger.load(root.id);
  assert.equal(pending.calls[0].result, undefined); assert.equal(root.status, 'in_progress');
  assert.equal(pending.calls[1].result, 'child');
  assert.equal(pending.calls[0].steps[0].observation, undefined);
  await rm(path, { recursive: true }); await writeFile(path, original);
  const result = await resumeRlm(workspace, root.id, model);
  assert.equal(result.answer, 'root'); assert.equal(childRequests, 1);
  const state = await ledger.load(root.id);
  for (const call of state.calls) assert.equal((await client.get(call.id, { depth: 'full' })).item.status, 'closed');
  assert.equal((await replayRlm(workspace, root.id)).answer, result.answer);
});
