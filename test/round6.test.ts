import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { readFile } from 'node:fs/promises';
import { createRlmContext, readCorpus, partitionItems } from '../src/environment.ts';
import { runRlm, resumeRlm, replayRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { PROTOCOL } from '../src/protocol.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Historical private data becomes safe evidence in both root and recursive tool observations. */
test('historical private observations are refused before persistence and survive resume replay', async t => {
  for (const recursive of [false, true]) await t.test(recursive ? 'child observation' : 'root observation', async t => {
    const { workspace, client } = await tracker(t);
    const item = (await client.create({ title: 'Historical source', description: workspace })).item;
    await client.update(item.id, { description: 'Public current description' });
    const context = await createRlmContext({ workspace, budget: 100000 });
    assert.ok(JSON.stringify((await context.history(item.id, { start: 0, end: 10 })).data).includes(workspace), 'Real SDK history retains the prior description');
    const slice = partitionItems((await readCorpus(workspace)).items, 10000)[0];
    const model = new ScriptedModel(request => {
      const input = JSON.parse(request.prompt.slice(PROTOCOL.length + 1)) as { question: string; transcript: { observation?: unknown }[] };
      if (recursive && input.question === 'root') return JSON.stringify(input.transcript.length === 0 ? { action: 'spawn', subgoal: 'child', slice } : { action: 'finish', answer: 'root recovered' });
      if (input.transcript.length === 0) return JSON.stringify({ action: 'history', id: item.id, start: 0, end: 10 });
      assert.partialDeepStrictEqual(input.transcript[0].observation, { refused: 'invalid' });
      assert.ok(!request.prompt.includes(workspace));
      return JSON.stringify({ action: 'finish', answer: `${input.question} recovered` });
    });
    const result = await runRlm('root', { workspace, model }).catch(() => assert.fail('Private history must be a recoverable observation refusal'));
    assert.equal(result.answer, 'root recovered');
    const ledger = new RlmLedger(workspace); const state = await ledger.load(result.run);
    assert.equal(state.calls.length, recursive ? 2 : 1);
    assert.partialDeepStrictEqual(state.calls[recursive ? 1 : 0].steps[0].observation, { refused: 'invalid' });
    assert.ok(!JSON.stringify(state).includes(workspace));
    const settled = state.calls.flatMap(call => call.steps).reduce((sum, step) => sum + step.reserved, 0);
    assert.equal(state.reserved_tokens, settled, 'Refused observations are not charged as delivered reads');
    for (const call of state.calls) {
      assert.equal((await client.get(call.id, { depth: 'full' })).item.status, 'closed');
      assert.ok(!(await readFile(getHistoryPath(workspace, call.id), 'utf8')).includes(workspace));
    }
    const requests = model.requests.length;
    assert.equal((await resumeRlm(workspace, result.run, model)).answer, result.answer);
    assert.equal((await replayRlm(workspace, result.run)).answer, result.answer);
    assert.equal(model.requests.length, requests);
    assert.deepEqual(await ledger.load(result.run), state, 'Recorded privacy refusal is reused without changes');
  });
});
