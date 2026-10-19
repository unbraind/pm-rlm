import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRlm, replayRlm, resumeRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { tracker, ScriptedModel } from './helpers.ts';

/** Issue 5: every string the engine records remains a loadable invalid-action refusal. */
test('empty model output remains replayable and completed resume performs no inference', async t => {
  const { workspace } = await tracker(t);
  for (const output of ['', '{', ' ']) {
    const model = new ScriptedModel((_request, index) => index === 0 ? output : '{"action":"finish","answer":"ok"}');
    const result = await runRlm('Recover from invalid JSON', { workspace, model });
    assert.equal(result.answer, 'ok'); assert.equal(model.requests.length, 2);
    assert.equal((await replayRlm(workspace, result.run).catch(error => assert.fail(`Engine-written response must replay: ${String(error)}`))).answer, 'ok');
    const noInference = new ScriptedModel(() => { throw new Error('Completed resume must not infer'); });
    assert.equal((await resumeRlm(workspace, result.run, noInference)).answer, 'ok');
    assert.equal(noInference.requests.length, 0);
  }
});

/** An interruption after a malformed response preserves its refusal and retries only unfinished inference. */
test('empty response interruption resumes while non-string checkpoint responses refuse', async t => {
  const { workspace, client } = await tracker(t);
  const model = new ScriptedModel((_request, index) => { if (index === 0) return ''; throw new Error('Process interrupted'); });
  await assert.rejects(runRlm('Interrupted empty response', { workspace, model }), /Process interrupted/);
  const root = (await client.listAllComplete()).items.find(item => typeof item.rlm_state === 'string')!;
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(root.id).catch(error => assert.fail(`Interrupted engine checkpoint must load: ${String(error)}`));
  assert.deepEqual(state.calls[0].steps[0].observation, { refused: 'invalid' });
  const finish = new ScriptedModel(() => '{"action":"finish","answer":"recovered"}');
  assert.equal((await resumeRlm(workspace, root.id, finish)).answer, 'recovered');
  assert.equal(finish.requests.length, 1);
  assert.equal((await replayRlm(workspace, root.id)).answer, 'recovered');
  const completed = await ledger.load(root.id);
  const bad = JSON.parse(JSON.stringify(completed)) as { calls: { steps: { response: { text: unknown } }[] }[] };
  bad.calls[0].steps[0].response.text = 0;
  await client.run('update', { id: root.id, options: { rlmState: JSON.stringify(bad) } });
  await assert.rejects(ledger.load(root.id), { code: 'incomplete' });
  for (const step of [{ ...completed.calls[0].steps[0], settled: false }, { ...completed.calls[0].steps[0], settled: true, response: undefined }]) {
    const state = { ...completed, calls: [{ ...completed.calls[0], steps: [step] }] };
    await client.run('update', { id: root.id, options: { rlmState: JSON.stringify(state) } });
    await assert.rejects(ledger.load(root.id), { code: 'incomplete' });
  }
});
