import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { getSettingsPath } from '@unbrained/pm-cli/sdk';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HttpModel } from '../src/adapters.ts';
import { assertLedgerPrivacy } from '../src/errors.ts';
import { runCommand } from '../src/commands.ts';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { RlmLedger } from '../src/ledger.ts';
import { runRlm, resumeRlm, replayRlm } from '../src/engine.ts';
import { readRlmSettings } from '../src/settings.ts';
import { readCorpus } from '../src/environment.ts';
import { questions, answerDistribution } from './eval-questions.ts';
import { tracker, ScriptedModel } from './helpers.ts';
import { httpFixture } from './http.ts';

/** Enforce a transport envelope cap even when the extracted model text is tiny. */
test('bounded HTTP envelopes refuse streamed metadata before JSON parsing', async t => {
  const { workspace } = await tracker(t);
  let mode = 'large';
  const { endpoint } = await httpFixture(t, (_request, response) => {
    if (mode === 'empty') { response.writeHead(204); response.end(); return; }
    if (mode === 'json') { response.end('{'); return; }
    response.write('{"response":"ok","metadata":"');
    for (let index = 0; index < 256; index++) response.write('x'.repeat(65536));
    response.end('"}');
  });
  const model = new HttpModel(await readRlmSettings(workspace, { endpoint }));
  const request = { prompt: 'q', max_output_tokens: 16, context_tokens: 32768 };
  await assert.rejects(model.complete(request), { code: 'model', message: 'Model response exceeds byte allowance' });
  mode = 'empty'; await assert.rejects(model.complete(request), { code: 'model', message: 'Model response body is missing' });
  mode = 'json'; await assert.rejects(model.complete(request), { code: 'model' });
});

/** Malformed JSON is a named input refusal; unrelated validation retains its diagnosis. */
test('malformed scope JSON identifies the flag', async t => {
  const { workspace } = await tracker(t);
  const context = { command: 'rlm run', pm_root: workspace, args: ['q'], options: { scope: '{' }, global: { author: 'rlm-test' } } as CommandHandlerContext;
  await assert.rejects(runCommand('run', context), { exitCode: 2, message: 'rlm invalid: Invalid --scope JSON' });
  await assert.rejects(runCommand('run', { ...context, options: { scope: '' } }), { exitCode: 2, message: 'rlm invalid: Expected nonempty text' });
  await writeFile(getSettingsPath(workspace), '{');
  await assert.rejects(runCommand('run', { ...context, options: {} }), { exitCode: 2, message: 'rlm incomplete: Workspace data could not be read completely' });
});

/** Escaped secrets and path separators cannot bypass serialization-time privacy checks. */
test('privacy rejects JSON-escaped needles and platform path roots', () => {
  const key = 'RLM_ESCAPED_TEST_KEY';
  const before = process.env[key];
  try {
    const workspace = join(tmpdir(), 'quoted-"-root', 'scratch', 'pm');
    process.env[key] = randomUUID() + '"\\\n';
    assert.throws(() => assertLedgerPrivacy({ output: process.env[key] }, workspace, key), { code: 'invalid' });
    delete process.env[key];
    assert.throws(() => assertLedgerPrivacy({ output: workspace }, workspace, key), { code: 'invalid' });
    assert.throws(() => assertLedgerPrivacy({ output: join(tmpdir(), 'quoted-"-root', 'other') }, workspace, key), { code: 'invalid' });
    assert.throws(() => assertLedgerPrivacy({ output: sep + 'private' }, sep, key), { code: 'invalid' });
    process.env[key] = '';
    assert.doesNotThrow(() => assertLedgerPrivacy({ output: 'safe' }, workspace, key));
  } finally { if (before === undefined) delete process.env[key]; else process.env[key] = before; }
});

/** Runtime and checkpoint configurations share strict HTTPS and credential-name validation. */
test('remote OpenAI credentials require HTTPS while loopback HTTP remains usable', async t => {
  const { workspace } = await tracker(t);
  for (const endpoint of ['http://example.invalid', 'http://localhost.example.invalid', 'not-a-url']) await assert.rejects(readRlmSettings(workspace, { adapter: 'openai', endpoint }), { code: 'invalid' });
  for (const endpoint of ['https://example.invalid/v1', 'http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234']) assert.equal((await readRlmSettings(workspace, { adapter: 'openai', endpoint })).endpoint, endpoint);
});

/** Corrupt checkpoint shapes are refused before resume can instantiate a transport. */
test('checkpoint validation returns incomplete for malformed calls and unsafe settings', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Snapshot entry' });
  const run = await runRlm('checkpoint', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"ok"}') });
  const ledger = new RlmLedger(workspace);
  const original = await ledger.load(run.run);
  const cases = [
    { ...original, calls: [null] }, { ...original, calls: [1] },
    { ...original, calls: [{ ...original.calls[0], steps: undefined }] },
    { ...original, calls: [{ ...original.calls[0], slice: { fragments: null } }] },
    { ...original, calls: [{ ...original.calls[0], depth: -1 }] },
    { ...original, calls: [{ ...original.calls[0], result: 1 }] },
    { ...original, calls: [{ ...original.calls[0], failure: { code: 'unknown' } }] },
    { ...original, calls: [{ ...original.calls[0], failure: { code: 'model' } }] },
    { ...original, calls: [{ ...original.calls[0], steps: [{ prompt: 'q', reserved: 1 }] }] },
    { ...original, snapshot: null }, { ...original, snapshot: [null] },
    { ...original, settings: { ...original.settings, endpoint: 'https://name:pass@example.invalid' } },
    { ...original, settings: { ...original.settings, adapter: 'openai', endpoint: 'http://example.invalid' } },
    { ...original, settings: { ...original.settings, endpoint: 'https://example.invalid?key=value' } },
    { ...original, settings: { ...original.settings, key_env: 'invalid-name' } },
  ];
  for (const [index, state] of cases.entries()) {
    await client.run('update', { id: run.run, options: { rlmState: JSON.stringify(state) } });
    if ([7, 8].includes(index)) { assert.ok(await ledger.load(run.run)); continue; }
    await assert.rejects(resumeRlm(workspace, run.run), { code: 'incomplete' });
    await assert.rejects(replayRlm(workspace, run.run), { code: 'incomplete' });
  }
  await ledger.save(original);
  assert.equal((await resumeRlm(workspace, run.run)).answer, 'ok');
});

/** Seeded truth-only selection is stable under item reordering and defeats constant guessing. */
test('seeded eval questions span magnitudes and cap answer frequency', async t => {
  const { workspace, client } = await tracker(t);
  for (let index = 0; index < 8; index++) await client.create({ id: `item-${index}`, title: 'Question '.repeat(index + 1), type: index % 2 ? 'Issue' : 'Task', description: 'x'.repeat(1700 + index * 150), acceptanceCriteria: 'Check '.repeat(index + 1) });
  const items = (await readCorpus(workspace)).items;
  const tasks = questions(items);
  assert.deepEqual(questions([...items].reverse()), tasks);
  assert.equal(tasks.length, 12);
  assert.equal(tasks[0].question, 'How many items of type Task are there?', 'Preserve historical seeded selection');
  assert.equal(tasks.at(-1)!.question, 'How many items with status open are there?');
  for (const task of tasks) {
    assert.ok(task.question.endsWith('?'));
    assert.doesNotMatch(task.question, /answer only|respond|return only|format|JSON|envelope|action/i, 'Questions must leave response formatting to each arm protocol');
  }
  const distribution = answerDistribution([...tasks, ...tasks]);
  assert.equal(distribution.questions, 24); assert.ok(distribution.most_common <= 4);
  assert.ok(distribution.zero <= 4);
  const numeric = tasks.filter(task => /^\d+$/.test(task.answer)).map(task => Number(task.answer));
  for (const [minimum, maximum] of [[1, 9], [10, 99], [100, 999], [1000, Infinity]]) assert.ok(numeric.some(value => value >= minimum && value <= maximum));
  assert.ok(tasks.some(task => task.answer.includes('item-')));
  assert.deepEqual(answerDistribution([]), { questions: 0, histogram: {}, most_common: 0, zero: 0 });
});
