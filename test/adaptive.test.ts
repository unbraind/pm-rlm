import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { adaptiveRlm, parseQuestionStructure, RlmAdaptiveError } from '../index.ts';
import { RlmError } from '../src/errors.ts';
import { RlmLedger } from '../src/ledger.ts';
import { replayRlm } from '../src/engine.ts';
import { runCommand } from '../src/commands.ts';
import { writeRlmSettings } from '../src/settings.ts';
import { tracker, ScriptedModel } from './helpers.ts';
import type { ModelRequest } from '../src/types.ts';

export const structure = [{ name: 'title', question: 'What is the title?' }, { name: 'cause', question: 'What caused it?' }, { name: 'outcome', question: 'What was the outcome?' }];
/** Parse the actual engine prompt for a deterministic answer fixture. */
function prompt(request: ModelRequest) {
  return JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1)) as { question: string; depth: number; transcript: { observation: { data: { digest: string } } }[] };
}
/** Return explicit unknowns rather than fabricate source support. */
export function unknownModel(): ScriptedModel {
  return new ScriptedModel(request => JSON.stringify({ action: 'answer', components: (JSON.parse(prompt(request).question) as { parts: typeof structure }).parts.map(part => ({ component: part.name, status: 'unknown', answer: '', reason: 'Not established by this fixture', witnesses: [] })) }));
}

test('tiny budgets return typed partials without git or model requests', async t => {
  const { workspace, root, client } = await tracker(t);
  const previousPath = process.env.PATH;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  t.after(() => { process.env.PATH = previousPath; if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling; });
  process.env.PATH = root;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const model = unknownModel();
  for (const remaining_tokens of [0, 1, 10]) {
    const result = await adaptiveRlm('Explain this issue', { workspace, structure, remaining_tokens, model, author: 'rlm-test' });
    assert.equal(result.status, 'partial');
    assert.equal(result.stop_reason, 'budget');
    assert.deepEqual(result.budget, { declared: remaining_tokens, limit: remaining_tokens, charged: 0, remaining: remaining_tokens });
    assert.equal(result.children.length, 0);
    assert.equal(result.components.length, 3);
    assert.ok(result.components.every(part => part.status === 'deferred' && part.refusal === 'budget' && part.remedy?.includes('remaining_tokens')));
    const item = (await client.listAllComplete()).items.find(item => item.id === result.run)!;
    assert.equal(item.status, 'closed');
    assert.equal(item.assignee, undefined);
    const comments = await client.comments(result.run);
    assert.ok(JSON.stringify(comments).includes('RLM adaptive result:'));
  }
  assert.equal(model.requests.length, 0);
});

test('strategy comparisons and stopped splitting are deterministic', async t => {
  const { workspace } = await tracker(t);
  const model = unknownModel();
  const first = await adaptiveRlm('Explain', { workspace, structure, remaining_tokens: 300000, model });
  const second = await adaptiveRlm('Explain', { workspace, structure, remaining_tokens: 300000, model });
  assert.deepEqual(second.comparisons, first.comparisons);
  assert.equal(first.selected, 'components');
  assert.equal(second.selected, first.selected);
  assert.equal(first.stop_reason, 'declared_leaves');
  assert.equal(first.children.length, 3);
  assert.equal(first.calls, 3);
  assert.equal(first.status, 'partial');
  assert.ok(first.components.every(part => part.status === 'unknown' && part.run !== undefined && part.refusal === undefined));
  assert.equal(model.requests.length, 6);
  assert.equal(first.budget.charged, first.children.reduce((sum, child) => sum + child.charged, 0));
  assert.equal(first.budget.remaining, 300000 - first.budget.charged);
  for (const child of first.children) assert.equal((await replayRlm(workspace, child.run)).components!.length, 1);
});

test('supported parts retain source evidence in child ledgers while output stays compact', async t => {
  const source = await tracker(t);
  const ledger = await tracker(t);
  const item = (await source.client.create({ title: 'Public title' })).item;
  const before = await source.client.listAllComplete({ includeBody: true });
  const model = new ScriptedModel(request => {
    const state = prompt(request);
    if (state.transcript.length === 0) return JSON.stringify({ action: 'witness', id: item.id, start: 0, end: 20 });
    return JSON.stringify({ action: 'answer', components: [{ component: 'title', status: 'supported', answer: 'Public title', reason: '', witnesses: [{ step: 0, digest: state.transcript[0].observation.data.digest }] }] });
  });
  const result = await adaptiveRlm('Title', { workspace: ledger.workspace, source_workspace: source.workspace, scope: { ids: [item.id] }, structure: structure.slice(0, 1), remaining_tokens: 50000, model });
  assert.equal(result.status, 'complete');
  assert.equal(result.components[0].status, 'supported');
  assert.equal(result.stop_reason, 'declared_leaves');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2000);
  assert.equal(JSON.stringify(result).includes('Public title'), false);
  assert.equal((await replayRlm(ledger.workspace, result.children[0].run)).components![0].answer, 'Public title');
  assert.deepEqual((await source.client.listAllComplete({ includeBody: true })).items, before.items);
});

test('child failures preserve terminal evidence and release all claims', async t => {
  const { workspace, client } = await tracker(t);
  for (const error of [new RlmError('model', 'Transport unavailable'), new Error('private diagnostic')]) {
    const model = new ScriptedModel(() => { throw error; });
    const result = await adaptiveRlm('Explain', { workspace, structure: structure.slice(0, 1), remaining_tokens: 50000, model });
    assert.equal(result.status, 'partial');
    assert.equal(result.stop_reason, 'child_failure');
    assert.equal(result.components[0].status, 'failed');
    assert.equal(result.components[0].refusal, 'model');
    assert.ok(result.components[0].remedy);
    const state = await new RlmLedger(workspace).load(result.children[0].run);
    assert.equal(state.calls[0].failure?.code, 'model');
    assert.equal(state.calls[0].steps.length, 1);
    assert.equal(state.calls[0].steps[0].response, undefined);
    assert.equal(state.reserved_tokens, result.budget.charged);
    const items = (await client.listAllComplete()).items;
    assert.ok(items.every(item => item.status === 'closed' && item.assignee === undefined));
    assert.match(JSON.stringify(await client.comments(state.run)), /RLM refusal:/);
    assert.equal(JSON.stringify(await client.comments(state.run)).includes('private diagnostic'), false);
  }
});

/** Request a native child using an empty authorized slice. */
function nestedAction(): string {
  return JSON.stringify({ action: 'spawn', subgoal: 'nested', slice: { fragments: [], estimated_tokens: 2 } });
}

/** Execute one group and recover its durable native state. */
async function singleGroup(workspace: string, model: ScriptedModel) {
  const result = await adaptiveRlm('Explain', { workspace, structure: structure.slice(0, 1), remaining_tokens: 100000, model });
  return { result, state: await new RlmLedger(workspace).load(result.children[0].run) };
}

test('nested child terminal refusals survive the adaptive controller', async t => {
  const { workspace, client } = await tracker(t);
  const model = new ScriptedModel(request => {
    const state = prompt(request);
    if (state.depth === 1) throw new RlmError('model', 'Child unavailable');
    // After the nested failure, fail the group root too, preserving both terminal records.
    if (state.transcript.length > 0) throw new RlmError('depth', 'Group stopped');
    return nestedAction();
  });
  const { result, state } = await singleGroup(workspace, model);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0].failure?.code, 'depth');
  assert.equal(state.calls[1].failure?.code, 'model');
  assert.match(result.components[0].remedy!, /depth/);
  assert.ok((await client.listAllComplete()).items.every(item => item.status === 'closed'));
});

test('budget, context and total call limits bound selected execution', async t => {
  const { workspace } = await tracker(t);
  const model = unknownModel();
  const reference = await adaptiveRlm('Explain', { workspace, structure, remaining_tokens: 300000, model });
  const whole = reference.comparisons[0].first_step_tokens;
  const limited = await adaptiveRlm('Explain', { workspace, structure, remaining_tokens: whole, model: new ScriptedModel(() => '{"action":"count","filter":{}}') });
  assert.equal(limited.selected, 'whole');
  assert.equal(limited.stop_reason, 'child_failure');
  assert.equal(limited.components[0].refusal, 'budget');
  assert.ok(limited.budget.charged <= whole);
  const context = await adaptiveRlm('Explain', { workspace, structure, remaining_tokens: 300000, model, settings: { context_tokens: 1024 } });
  assert.equal(context.stop_reason, 'context');
  assert.equal(context.calls, 0);
  const lowSettings = await adaptiveRlm('Explain', { workspace, structure, remaining_tokens: 300000, model, settings: { budget_tokens: 1 } });
  assert.equal(lowSettings.stop_reason, 'budget');
  assert.equal(lowSettings.budget.remaining, 1);
  const calls = await adaptiveRlm('Explain', { workspace, structure, remaining_tokens: 300000, model, settings: { max_calls: 1 } });
  assert.equal(calls.selected, 'whole');
  assert.equal(calls.calls, 1);
  assert.equal(calls.comparisons[2].reason, 'calls');
});

test('shared call slots defer later groups after a nested call uses the remaining capacity', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel(request => {
    const state = prompt(request);
    if (state.depth === 1) throw new RlmError('model', 'Nested refusal');
    if (state.transcript.length === 0) return nestedAction();
    return JSON.stringify({ action: 'answer', components: (JSON.parse(state.question) as { parts: typeof structure }).parts.map(part => ({ component: part.name, status: 'unknown', answer: '', reason: 'Not established', witnesses: [] })) });
  });
  const result = await adaptiveRlm('Explain', { workspace, structure: structure.slice(0, 2), remaining_tokens: 100000, model, settings: { max_calls: 2 } });
  assert.equal(result.selected, 'components');
  assert.equal(result.calls, 2);
  assert.equal(result.stop_reason, 'calls');
  assert.equal(result.components[1].status, 'deferred');
  assert.equal(result.components[1].refusal, 'calls');
  assert.match(result.components[1].remedy!, /call/);
});

test('unexpected nested failures seal every unfinished native call', async t => {
  const { workspace, client } = await tracker(t);
  const model = new ScriptedModel(request => {
    if (prompt(request).depth === 1) throw new Error('private transport detail');
    return nestedAction();
  });
  const { state } = await singleGroup(workspace, model);
  assert.equal(state.calls.length, 2);
  assert.ok(state.calls.every(call => call.failure?.code === 'model'));
  assert.ok((await client.listAllComplete()).items.every(item => item.status === 'closed' && item.assignee === undefined));
});

test('controller persistence failure refuses instead of claiming a durable result', async t => {
  const { workspace } = await tracker(t);
  await rm(join(workspace, 'tasks'), { recursive: true, force: true });
  await writeFile(join(workspace, 'tasks'), 'blocked');
  await assert.rejects(adaptiveRlm('Explain', { workspace, structure, remaining_tokens: 0 }), error => error instanceof RlmAdaptiveError && error.code === 'incomplete' && !error.message.includes(workspace) && error.remedy.length > 0);
});

test('third-party adapter initialization diagnostics stay sanitized', async t => {
  const { workspace, client } = await tracker(t);
  const model = unknownModel();
  Object.defineProperty(model, 'name', { get() { throw new Error('private adapter detail'); } });
  await assert.rejects(adaptiveRlm('Explain', { workspace, structure, remaining_tokens: 100000, model }), error => error instanceof RlmAdaptiveError && error.code === 'incomplete' && !error.message.includes('private adapter') && error.remedy.length > 0);
  assert.ok((await client.listAllComplete()).items.every(item => item.assignee === undefined));
});

test('structure and declared budgets refuse malformed input with remedies before writes', async t => {
  const { workspace, client } = await tracker(t);
  for (const value of [null, [], [null], [{ name: 'x', question: '' }], [{ name: 'x', question: 1 }], [{ name: 'x', question: 'a', extra: true }], [{ name: 2, question: 'a' }], [{ name: 'x', question: 'a'.repeat(4097) }], [structure[0], structure[0]], Array.from({ length: 17 }, (_, index) => ({ name: String(index), question: 'Q' }))]) {
    assert.throws(() => parseQuestionStructure(value), RlmAdaptiveError);
  }
  assert.deepEqual(parseQuestionStructure(structure), structure);
  for (const question of ['', '  ', 'x'.repeat(4097)]) await assert.rejects(adaptiveRlm(question, { workspace, structure, remaining_tokens: 0 }), { code: 'invalid' });
  for (const remaining_tokens of [-1, 1.5, NaN, 1000000001]) await assert.rejects(adaptiveRlm('Q', { workspace, structure, remaining_tokens }), error => error instanceof RlmAdaptiveError && error.code === 'invalid' && error.remedy.length > 0);
  await assert.rejects(adaptiveRlm('Q', { workspace, structure, remaining_tokens: 0, scope: { extra: 'x' } as never }), RlmAdaptiveError);
  await assert.rejects(adaptiveRlm('Q', { workspace: join(workspace, 'absent'), structure, remaining_tokens: 0 }), { code: 'incomplete' });
  assert.equal((await client.listAllComplete()).items.length, 0);
});

test('native adaptive command renders bounded TOON and JSON in a plain tracker', async t => {
  const { workspace, root } = await tracker(t);
  const directory = join(workspace, 'extensions', 'pm-rlm');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ name: 'pm-rlm', version: '2026.10.18', entry: 'entry.js', capabilities: ['commands', 'schema'] }));
  await writeFile(join(directory, 'entry.js'), `export { default } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};\n`);
  for (const json of [true, false]) {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', 'adaptive', 'Explain', '--structure', JSON.stringify(structure), '--budget-tokens', '0', ...(json ? ['--json'] : [])], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: root, GIT_CEILING_DIRECTORIES: dirname(root), PM_PATH: workspace } });
    assert.equal(run.status, 0, run.stderr);
    const result = (json ? JSON.parse(run.stdout) : decodeToon(run.stdout)) as { status: string; components: unknown[] };
    assert.equal(result.status, 'partial');
    assert.equal(result.components.length, 3);
    assert.ok(Buffer.byteLength(run.stdout) < 3500);
  }
  const ctx = { command: 'rlm adaptive', pm_root: workspace, args: ['Q'], global: {}, options: {} } as CommandHandlerContext;
  for (const options of [{}, { structure: '[' }, { structure: '[]' }, { structure: JSON.stringify(structure) }, { structure: JSON.stringify(structure), budgetTokens: '-1' }]) await assert.rejects(runCommand('adaptive', { ...ctx, options }), { exitCode: 2 });
  await writeRlmSettings(workspace, { context_tokens: 1024 }, 'rlm-test');
  const result = await runCommand('adaptive', { ...ctx, options: { structure: JSON.stringify(structure), budgetTokens: '100000', maxDepth: '1', maxCalls: '1', scope: '{}', model: 'unused' } });
  assert.equal(result.stop_reason, 'context');
});
