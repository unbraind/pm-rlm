import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, symlink, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { readCorpus, partitionItems } from '../src/environment.ts';
import { prepareRlmRun, replayRlm, resumeRlm, runRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { compactReuseResult, reuseRlm, validateReuseState } from '../src/reuse.ts';
import { parseReuseIdentity, parseReuseSelection, parseReuseProvenance, RlmReuseError } from '../src/reuse-contract.ts';
import type { RlmReuseIdentity } from '../src/reuse-contract.ts';
import type { RlmReuseOptions } from '../src/reuse.ts';
import type { RlmState } from '../src/types.ts';
import { tracker, ScriptedModel, installExtension } from './helpers.ts';
import { httpFixture } from './http.ts';
import { writeRlmSettings } from '../src/settings.ts';
import { runCommand } from '../src/commands.ts';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import type { TestContext } from 'node:test';

const identity: RlmReuseIdentity = { tool_policy: 'snapshot-v1', model_policy: 'test-model-v1', consent: 'public-fixture:1' };
const finish = '{"action":"finish","answer":"verified answer"}';

/** Prepare one completed source and matching explicit target request. */
async function original(t: TestContext) {
  const setup = await tracker(t);
  const source = await setup.client.create({ title: 'Source', type: 'Issue', description: 'source text', tags: 'source' });
  const model = new ScriptedModel(() => finish);
  const options = { workspace: setup.workspace, scope: { tag: 'source' }, reuse_identity: identity, model };
  const run = await runRlm('question', options);
  const state = await new RlmLedger(setup.workspace).load(run.run);
  const request: RlmReuseOptions = { workspace: setup.workspace, scope: options.scope, reuse_identity: identity, selection: { run: run.run, call: run.run }, settings: state.settings };
  return { ...setup, source: source.item.id, model, run, state, request };
}

/** Successful reuse creates a native zero-usage root and survives SDK storage and native replay. */
test('explicit matching subanswer satisfies a new run without new model requests or duplicate usage', async t => {
  const { request, workspace, model, run, client } = await original(t);
  const result = await reuseRlm('question', request);
  assert.equal(result.status, 'reused');
  if (result.status !== 'reused') return assert.fail();
  assert.equal(result.answer, run.answer);
  assert.equal(result.model_calls, 0);
  assert.equal(result.tokens_in, 0); assert.equal(result.tokens_out, 0); assert.equal(result.reserved_tokens, 0);
  assert.equal(result.reuse!.run, run.run); assert.ok(result.reuse!.tokens_in > 0);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(await replayRlm(workspace, result.run), await resumeRlm(workspace, result.run, model));
  const native = (await client.get(result.run, { depth: 'full' })).item;
  assert.equal(native.rlm_tokens_in, 0); assert.equal(native.rlm_tokens_out, 0);
  const state = await new RlmLedger(workspace).load(result.run);
  assert.equal(state.calls[0].steps.length, 0);
  const second = await reuseRlm('question', request);
  assert.equal(second.status, 'reused');
  assert.equal(model.requests.length, 1);
});

/** Each contract dimension rejects independently, before any new inference. */
test('identity question scope settings revision and legacy opt-in mismatches refuse with remedies', async t => {
  const { request, client, source, workspace, run, model } = await original(t);
  const cases: [string, string, RlmReuseOptions][] = [
    ['question', 'other', request],
    ['scope', 'question', { ...request, scope: {} }],
    ['settings', 'question', { ...request, settings: { ...request.settings, max_calls: 3 } }],
    ...(['tool_policy', 'model_policy', 'consent'] as const).map(key => ['identity', 'question', { ...request, reuse_identity: { ...identity, [key]: 'changed' } }] as [string, string, RlmReuseOptions]),
  ];
  for (const [dimension, question, options] of cases) await assert.rejects(reuseRlm(question, options), { dimension });
  await client.update(source, { description: 'changed source' });
  await assert.rejects(reuseRlm('question', request), { dimension: 'snapshot' });
  const legacy = await runRlm('legacy', { workspace, model });
  await assert.rejects(reuseRlm('legacy', { ...request, selection: { run: legacy.run, call: legacy.run } }), { dimension: 'original_opt_in' });
  await assert.rejects(reuseRlm('question', { ...request, selection: { run: run.run, call: 'absent' } }), { dimension: 'completion' });
  assert.ok(new RlmReuseError('identity').remedy.length > 0);
});

/** Real partial slices bind whole row revisions, while unrelated rows do not invalidate child results. */
test('one source revision invalidates only dependent selected calls', async t => {
  const { workspace, client } = await tracker(t);
  const a = (await client.create({ title: 'A', type: 'Issue', tags: 'source' })).item.id;
  const b = (await client.create({ title: 'B', type: 'Issue', tags: 'source' })).item.id;
  const corpus = await readCorpus(workspace);
  const slices = [a, b].map(id => partitionItems(corpus.items.filter(item => item.id === id), 10000)[0]);
  const model = new ScriptedModel(request => {
    const input: { transcript: unknown[]; question: string } = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
    if (input.question !== 'root' || input.transcript.length === 2) return finish;
    const subgoal = ['part-a', 'part-b'][input.transcript.length];
    return JSON.stringify({ subgoal, slice: slices[input.transcript.length], action: 'spawn' });
  });
  const run = await runRlm('root', { workspace, model, scope: { tag: 'source' }, reuse_identity: identity });
  const state = await new RlmLedger(workspace).load(run.run);
  const request = { workspace, reuse_identity: identity, scope: state.scope, settings: state.settings };
  await client.update(a, { description: 'revised' });
  await assert.rejects(reuseRlm('part-a', { ...request, selection: { run: run.run, call: state.calls[1].id } }), { dimension: 'snapshot' });
  const reused = await reuseRlm('part-b', { ...request, selection: { run: run.run, call: state.calls[2].id } });
  assert.equal(reused.status, 'reused');
  await assert.rejects(reuseRlm('root', { ...request, selection: { run: run.run, call: run.run } }), { dimension: 'snapshot' });
  assert.equal(model.requests.length, 5);
});

/** Foreign rows stay untouched and invalid API values cannot reach native writes. */
test('strict reuse schemas reject extreme inputs and skip foreign native records', async t => {
  const { request, source, client } = await original(t);
  const before = (await client.get(source, { depth: 'full' })).item;
  for (const run of ['absent', source]) assert.deepEqual(await reuseRlm('question', { ...request, selection: { run, call: run } }), { status: 'skipped', reason: 'foreign', remedy: 'Select a run created by pm-rlm in this tracker' });
  assert.deepEqual((await client.get(source, { depth: 'full' })).item, before);
  for (const value of [null, [], new Array(4), Infinity, -Infinity, NaN, {}, { ...identity, consent: '' }, { ...identity, consent: 'a'.repeat(129) }, { ...identity, other: true }, { ...identity, consent: 'white space' }]) assert.throws(() => parseReuseIdentity(value), RlmReuseError);
  for (const value of [null, [], {}, { run: 'x', call: 'x', extra: true }, { run: 'x', call: 4 }, { run: 'x', call: 'a'.repeat(161) }]) assert.throws(() => parseReuseSelection(value), RlmReuseError);
  const reused = await reuseRlm('question', request);
  assert.equal(reused.status, 'reused');
  if (reused.status !== 'reused') return assert.fail();
  for (const key of ['tokens_in', 'tokens_out', 'reserved_tokens']) for (const value of [Infinity, -Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined, '1', null]) assert.throws(() => parseReuseProvenance({ ...reused.reuse, [key]: value }), RlmReuseError);
  for (const field of ['tokens_in', 'tokens_out', 'reserved_tokens']) for (const value of [Infinity, -Infinity, NaN, -1, 0.5, 1, 1000000001]) assert.throws(() => compactReuseResult({ ...reused, [field]: value }));
  for (const calls of [0, 2, Infinity, NaN, 0.5]) assert.throws(() => compactReuseResult({ ...reused, calls }));
  assert.deepEqual(parseReuseIdentity(identity), identity);
});

/** No Git executable is available to either the SDK or native CLI renderer. */
test('native reuse CLI emits bounded JSON and TOON without git and reports typed remedies', async t => {
  const { request, root, workspace } = await original(t);
  await installExtension(workspace);
  await access(join(root, '.git')).then(() => assert.fail(), error => assert.equal(error.code, 'ENOENT'));
  const bin = join(root, 'bin'); await mkdir(bin); await symlink(process.execPath, join(bin, 'node'));
  const args = ['rlm', 'reuse', 'question', '--from', request.selection.run, '--call', request.selection.call, '--identity', JSON.stringify(identity), '--scope', JSON.stringify(request.scope), '--model', request.settings!.model!];
  for (const format of ['--json', '--output-format=toon']) {
    const cli = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), ...args, format], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root), PM_PATH: workspace } });
    assert.equal(cli.status, 0, cli.stderr);
    const result = (format === '--json' ? JSON.parse(cli.stdout) : decodeToon(cli.stdout)) as { status: string; tokens_in: number };
    assert.equal(result.status, 'reused'); assert.equal(result.tokens_in, 0); assert.ok(Buffer.byteLength(cli.stdout) < 1800);
  }
  const cli = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), ...args, '--identity', JSON.stringify({ ...identity, consent: 'changed' }), '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin, PM_PATH: workspace } });
  assert.equal(cli.status, 2); assert.match(cli.stderr, /remedy:/);
});

/** Native dispatch keeps full output opt-in and gives malformed identity JSON a remedy. */
test('reuse dispatch supports full results foreign skips and malformed identity remedies', async t => {
  const { request, workspace, source } = await original(t);
  const context = { command: 'rlm reuse', pm_root: workspace, args: ['question'], global: { author: 'rlm-test' }, options: { full: true, from: request.selection.run, call: request.selection.call, identity: JSON.stringify(identity), scope: JSON.stringify(request.scope), model: request.settings!.model } } as CommandHandlerContext;
  assert.equal((await runCommand('reuse', context)).answer, 'verified answer');
  const foreign = await runCommand('reuse', { ...context, options: { ...context.options, from: source, call: source, full: false } });
  assert.equal(foreign.status, 'skipped');
  await assert.rejects(runCommand('reuse', { ...context, options: { ...context.options, identity: '{' } }), { exitCode: 2 });
  await assert.rejects(runCommand('reuse', { ...context, options: { ...context.options, identity: undefined } }), { exitCode: 2 });
});

/** The real host run dispatcher records opt-in before its sole HTTP model request. */
test('CLI run records reuse identity before inference and reuses without contacting its model', async t => {
  const { workspace } = await tracker(t);
  let requests = 0;
  const { endpoint } = await httpFixture(t, (_request, response) => { requests++; response.end(JSON.stringify({ response: finish, prompt_eval_count: 20, eval_count: 5 })); });
  await writeRlmSettings(workspace, { endpoint }, 'rlm-test');
  const context = { command: 'rlm run', pm_root: workspace, args: ['question'], global: { author: 'rlm-test' }, options: { model: 'http-test', identity: JSON.stringify(identity) } } as CommandHandlerContext;
  const original = await runCommand('run', context);
  const reused = await runCommand('reuse', { ...context, options: { ...context.options, from: original.run, call: original.run } });
  assert.equal(reused.status, 'reused'); assert.equal(requests, 1);
  const state = await new RlmLedger(workspace).load(String(original.run));
  assert.deepEqual(state.reuse_identity, identity); assert.equal(state.snapshot_only, true);
});
