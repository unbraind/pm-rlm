import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questions, stuffing, stuffingAnswer, liveSettings, newRoot, rootIds } from './live.ts';
import { tracker } from './helpers.ts';
import { readCorpus } from '../src/environment.ts';
import { writeRlmSettings, readRlmSettings } from '../src/settings.ts';

/** Ground truth is derived exactly from complete real SDK data, including deterministic tie breaking. */
test('eval generates twenty-four exact public-tracker-style aggregation questions and bounded stuffing', async t => {
  const { workspace, client } = await tracker(t);
  const epic = (await client.create({ id: 'epic-a', title: 'Most children', type: 'Epic' })).item;
  await client.create({ id: 'epic-b', title: 'Other', type: 'Epic' });
  await client.create({ title: 'Coverage issue', type: 'Issue', acceptanceCriteria: 'Test SDK release budget coverage' });
  const child = (await client.create({ title: 'Closed task', type: 'Task', parent: epic.id })).item;
  await client.close(child.id, 'Done', { validateClose: 'off' });
  await client.create({ title: 'Generated question', type: 'Task', tags: 'rlm:question' });
  await client.create({ title: 'Execution call', type: 'Task', tags: 'rlm:call' });
  const items = (await readCorpus(workspace)).items;
  assert.equal(items.length, 4);
  const cases = questions(items);
  assert.equal([...cases, ...questions(items)].length, 24);
  assert.equal(cases[0].answer, '1'); assert.equal(cases[2].answer, '0'); assert.equal(cases[3].answer, '1');
  assert.ok(cases.slice(6, 11).every(item => item.answer === '1'));
  assert.equal(cases[11].answer, epic.id);
  assert.equal(questions([])[11].answer, 'none');
  const config = await readRlmSettings(workspace, { context_tokens: 512, output_tokens: 32 });
  const prompt = stuffing(cases[0].question, items, config);
  assert.ok(Buffer.byteLength(prompt) <= 480);
  assert.ok(prompt.includes('Question:'));
  assert.ok(Array.isArray(JSON.parse(prompt.split('Workspace:\n')[1])));
  assert.ok(stuffing('question', [], config).endsWith('[]'));
});

/** Eval transport and attribution cannot inherit provider settings or reuse old roots. */
test('eval pins local transport and scores explicit JSON answers', async t => {
  const { workspace } = await tracker(t);
  const originalModel = process.env.PM_RLM_LIVE_MODEL;
  const originalEndpoint = process.env.PM_RLM_LIVE_BASE_URL;
  t.after(() => {
    if (originalModel === undefined) delete process.env.PM_RLM_LIVE_MODEL; else process.env.PM_RLM_LIVE_MODEL = originalModel;
    if (originalEndpoint === undefined) delete process.env.PM_RLM_LIVE_BASE_URL; else process.env.PM_RLM_LIVE_BASE_URL = originalEndpoint;
  });
  const defaults = await readRlmSettings(workspace);
  await writeRlmSettings(workspace, { adapter: 'openai', endpoint: 'https://example.invalid', key_env: 'RLM_OTHER_PROVIDER_KEY', context_tokens: 1024, output_tokens: 32, budget_tokens: 1000 }, 'rlm-test');
  process.env.PM_RLM_LIVE_MODEL = 'synthetic-local';
  process.env.PM_RLM_LIVE_BASE_URL = 'http://127.0.0.1:11434';
  const config = await liveSettings(workspace);
  assert.equal(config.adapter, 'ollama'); assert.equal(config.model, 'synthetic-local');
  for (const key of ['context_tokens', 'output_tokens', 'budget_tokens'] as const) assert.equal(config[key], defaults[key]);
  assert.equal(config.key_env, 'PM_RLM_LIVE_UNUSED_KEY');
  for (const endpoint of ['https://example.invalid', 'http://localhost@external.invalid', 'http://127.0.0.1/path', 'http://localhost?key=x']) {
    process.env.PM_RLM_LIVE_BASE_URL = endpoint;
    await assert.rejects(liveSettings(workspace));
  }
  assert.equal(stuffingAnswer('{"answer":"epic-id"}'), 'epic-id');
  assert.equal(stuffingAnswer('{"answer":"12"}'), '12');
  for (const response of ['12', 'null', '{', '{"answer":12}']) assert.equal(stuffingAnswer(response), '');
  assert.equal(newRoot(['old'], ['old']), undefined);
  assert.equal(newRoot(['old'], ['old', 'new']), 'new');
  assert.deepEqual(await rootIds(workspace), []);
});
