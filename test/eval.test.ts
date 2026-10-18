import assert from 'node:assert/strict';
import { test } from 'node:test';
import { questions, stuffing } from './live.ts';
import { tracker } from './helpers.ts';
import { readCorpus } from '../src/environment.ts';
import { readRlmSettings } from '../src/settings.ts';

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
  assert.ok(stuffing('question', [], config).endsWith('[]'));
});
