import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExtensionCommandSdk, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { RlmLedger } from '../src/ledger.ts';
import { runRlm, replayRlm, treeRlm } from '../src/engine.ts';
import { readRlmSettings } from '../src/settings.ts';
import type { ModelResponse, RlmCall } from '../src/types.ts';
import { ScriptedModel, tracker } from './helpers.ts';
import { PROTOCOL } from '../src/protocol.ts';

/** Corrupt checkpoints remain typed refusals rather than partially reconstructed execution state. */
test('schema collisions and malformed SDK checkpoints fail closed', async t => {
  const incompatible = await tracker(t);
  await incompatible.client.schemaAddField('rlm_run', { type: 'number' });
  await assert.rejects(new RlmLedger(incompatible.workspace).registerFields(), { code: 'invalid' });
  const { workspace, client } = await tracker(t);
  const run = await runRlm('checkpoint', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"ok"}') });
  const ledger = new RlmLedger(workspace);
  const normal = await ledger.load(run.run);
  for (const value of ['{', JSON.stringify({ version: 0 }), JSON.stringify({ version: 1, run: 'wrong' }), JSON.stringify({ version: 1, run: run.run, calls: false }), JSON.stringify({ version: 1, run: run.run, calls: [] })]) {
    await client.run('update', { id: run.run, options: { rlmState: value } });
    await assert.rejects(ledger.load(run.run), { code: 'incomplete' });
  }
  await ledger.save(normal);
  await assert.rejects(ledger.load(normal.snapshot[0]?.id ?? 'absent'), { code: 'invalid' });
  const question = (await client.listAllComplete()).items.find(item => item.tags.includes('rlm:question'))!;
  await assert.rejects(ledger.load(question.id), { code: 'invalid' });
  const recovered: RlmCall = { ...normal.calls[0], id: `${run.run}-external`, parent: run.run, depth: 1, steps: [{ prompt: 'reserved external step', reserved: 1 }], result: 'external result' };
  await ledger.materialize(normal, recovered); await ledger.complete(normal, recovered);
  const row = (await client.get(recovered.id, { depth: 'full' })).item;
  assert.equal(row.rlm_tokens_in, 0); assert.equal(row.rlm_tokens_out, 0);
});

/** Untrusted transports cannot persist malformed response records. */
test('invalid model shapes and usage counters refuse before response persistence', async t => {
  const { workspace } = await tracker(t);
  const base = { text: '{"action":"finish","answer":"ok"}', tokens_in: 1, tokens_out: 1 };
  for (const bad of [{ ...base, text: 1 }, { ...base, text: 'x'.repeat(9000) }, { ...base, tokens_in: NaN }, { ...base, tokens_out: NaN }, { ...base, tokens_in: -1 }, { ...base, tokens_out: -1 }]) {
    await assert.rejects(runRlm('invalid transport', { workspace, model: { name: 'invalid-test-model', complete: async () => bad as unknown as ModelResponse } }), { code: 'model' });
  }
});

/** Invalid SDK history is a billable typed refusal and cannot strand a successful call. */
test('history transport failure and unfinished tree state retain their real SDK evidence', async t => {
  const { workspace, client } = await tracker(t);
  const item = (await client.create({ title: 'History failure' })).item;
  await appendFile(getHistoryPath(workspace, item.id), '\ninvalid-history-json\n');
  const model = new ScriptedModel((_request, index) => JSON.stringify(index === 0 ? { action: 'history', id: item.id, start: 0, end: 1 } : { action: 'finish', answer: 'recovered' }));
  const result = await runRlm('history failure', { workspace, model });
  assert.equal(result.answer, 'recovered');
  assert.partialDeepStrictEqual((await new RlmLedger(workspace).load(result.run)).calls[0].steps[0].observation, { refused: 'incomplete' });
  const roots = (await client.listAllComplete()).items.filter(item => typeof item.rlm_state === 'string');
  const tree = await treeRlm(workspace, roots[0].id) as { calls: { status: string; result: string }[] };
  assert.equal(tree.calls[0].status, 'closed'); assert.equal(tree.calls[0].result, 'recovered');
});

/** Settings are extension-owned but use the audited public SDK mutation service. */
test('missing settings use defaults while unknown extension settings are refused', async t => {
  const { root, workspace, client } = await tracker(t);
  assert.equal((await readRlmSettings(join(root, 'missing'))).max_depth, 3);
  const sdk = createExtensionCommandSdk(workspace, client, 'rlm-test');
  await sdk.mutateWorkspaceSettings({ operationId: 'bad-settings', mutate: current => ({ ...current, rlm: { unexpected: true } }) });
  await assert.rejects(readRlmSettings(workspace), { code: 'invalid' });
});

/** Replay validates spawn returns and skips unfinished recorded inference without calling a model. */
test('replay refuses missing children, changed returned values and malformed read observations', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel(request => {
    const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { question: string; transcript: unknown[] };
    return JSON.stringify(input.question === 'child' || input.transcript.length > 0 ? { action: 'finish', answer: 'ok' } : { action: 'spawn', subgoal: 'child', slice: { fragments: [], estimated_tokens: 2 } });
  });
  const run = await runRlm('replay graph', { workspace, model });
  const ledger = new RlmLedger(workspace); const original = await ledger.load(run.run);
  const altered = structuredClone(original); altered.calls[0].steps[0].observation = { result: 'altered' }; await ledger.save(altered);
  await assert.rejects(replayRlm(workspace, run.run), { code: 'replay' });
  altered.calls.pop(); await ledger.save(altered);
  await assert.rejects(replayRlm(workspace, run.run), { code: 'replay' });
  const interrupted = structuredClone(original); interrupted.calls[0].steps.unshift({ prompt: 'unfinished', reserved: 1 }); await ledger.save(interrupted);
  assert.equal((await replayRlm(workspace, run.run)).answer, 'ok');
  const readRun = await runRlm('read observations', { workspace, model: new ScriptedModel((_request, index) => index === 0 ? '{"action":"list"}' : '{"action":"finish","answer":"ok"}') });
  const state = await ledger.load(readRun.run);
  for (const observation of [null, 'bad']) {
    state.calls[0].steps[0].observation = observation; await ledger.save(state);
    await assert.rejects(replayRlm(workspace, readRun.run), { code: 'replay' });
  }
});
