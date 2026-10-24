import { replaceCheckpointFixture } from './checkpoint-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { reconcileRlm, parseReconcileArms, RlmReconcileError } from '../index.ts';
import type { RlmReconcileOptions, RlmReconcileResult } from '../index.ts';
import { replayRlm, resumeRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { RlmError } from '../src/errors.ts';
import { runCommand } from '../src/commands.ts';
import { writeRlmSettings } from '../src/settings.ts';
import { tracker, ScriptedModel } from './helpers.ts';
import { httpFixture, requestBody } from './http.ts';
import type { ModelRequest, RlmState, RlmCall } from '../src/types.ts';

/** Common semantic leaves; only their grouping changes between arms. */
const structure = [{ name: 'title', question: 'What is the title?' }, { name: 'status', question: 'What is the status?' }];
/** Explicit whole-question and component-wise decompositions. */
const arms: RlmReconcileOptions['arms'] = [{ groups: [['title', 'status']], budget_tokens: 100000 }, { groups: [['title'], ['status']], budget_tokens: 100000 }];
/** Read the actual engine state, excluding protocol examples. */
function state(request: ModelRequest) {
  return JSON.parse(request.prompt.split('\n').at(-1)!) as { question: string; depth: number; transcript: { observation: { data: { digest: string }; refused?: string } }[] };
}
/** Return unknowns without inventing evidence. */
function unknown(request: ModelRequest): string {
  const parts = (JSON.parse(state(request).question) as { parts: typeof structure }).parts;
  return JSON.stringify({ action: 'answer', components: parts.map(part => ({ component: part.name, status: 'unknown', answer: '', reason: 'No evidence', witnesses: [] })) });
}
/** Build source-backed answers with one deliberate conflict between the decompositions. */
export function pairedResponse(request: ModelRequest, id: string): string {
  const current = state(request);
  const parts = (JSON.parse(current.question) as { parts: typeof structure }).parts;
  if (current.transcript.length === 0) return JSON.stringify({ action: 'witness', id, start: 0, end: 20 });
  return JSON.stringify({ action: 'answer', components: parts.map(part => ({ component: part.name, status: 'supported', answer: part.name === 'title' ? parts.length === 2 ? 'First interpretation' : 'Conflicting interpretation' : 'open', reason: '', witnesses: [{ step: 0, digest: current.transcript[0].observation.data.digest }] })) });
}

test('paired evidence preserves disagreements and the immutable boundary without git', async t => {
  const { workspace, root, client } = await tracker(t);
  const source = (await client.create({ title: 'Captured title' })).item;
  const oldPath = process.env.PATH;
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = root;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => { process.env.PATH = oldPath; if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling; });
  const options = { workspace, structure: structuredClone(structure), arms, reserved_tokens: 200000, scope: { ids: [source.id] } };
  const model = new ScriptedModel(async (request, index) => {
    if (index === 2) { await client.update(source.id, { title: 'Changed after capture' }); options.structure[0].question = 'Mutation must not escape'; }
    return pairedResponse(request, source.id);
  });
  const report = await reconcileRlm('Explain the source', { ...options, model });
  assert.equal(report.status, 'complete');
  assert.equal(report.interpretation, 'exact_answer_comparison_not_truth');
  assert.deepEqual(report.comparisons, [{ component: 'title', relation: 'disagreement' }, { component: 'status', relation: 'equal_text' }]);
  assert.equal(report.boundary.items, 1);
  assert.match(report.boundary.digest, /^[a-f0-9]{64}$/);
  assert.equal(model.requests.length, 6);
  const states = await Promise.all(report.arms.flatMap(arm => arm.groups.map(group => new RlmLedger(workspace).load(group.run))));
  assert.ok(states.every(entry => entry.snapshot[0].title === 'Captured title' && entry.snapshot_only === true));
  assert.ok(states.every(entry => !entry.question.includes('Mutation must not escape')));
  assert.deepEqual(states[0].certificate, states[2].certificate);
  for (const arm of report.arms) {
    assert.ok(arm.charged <= arm.budget_tokens);
    for (const group of arm.groups) {
      const replay = await replayRlm(workspace, group.run);
      assert.deepEqual(replay.components, group.components);
      assert.equal(replay.reserved_tokens, group.charged);
      assert.ok(group.components.every(component => component.witnesses.length === 1));
    }
  }
  assert.equal(report.budget.charged, report.arms.reduce((sum, arm) => sum + arm.charged, 0));
  assert.equal(report.budget.remaining, report.budget.reserved - report.budget.charged);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 5000);
  assert.ok(JSON.stringify(await client.comments(report.run)).includes('RLM reconciliation result:'));
  assert.equal((await client.listAllComplete()).items.find(item => item.id === report.run)?.assignee, undefined);
  const ledger = new RlmLedger(workspace);
  Object.assign(states[0], { snapshot_only: false });
  await replaceCheckpointFixture(ledger, states[0]);
  await assert.rejects(ledger.load(states[0].run), { code: 'incomplete' });
});

test('paired admission refuses over-reservation before writes or inference', async t => {
  const { workspace, client } = await tracker(t);
  const before = (await client.listAllComplete()).items.length;
  const model = new ScriptedModel(unknown);
  for (const [overrides, code] of [
    [{ reserved_tokens: 199999 }, 'budget'],
    [{ settings: { budget_tokens: 199999 } }, 'budget'],
    [{ settings: { max_calls: 2 } }, 'calls'],
    [{ arms: arms.map(arm => ({ ...arm, budget_tokens: 1 })) }, 'budget'],
    [{ reserved_tokens: -1 }, 'invalid'],
    [{ settings: { context_tokens: 1024 } }, 'budget'],
    [{ workspace: 'missing-tracker' }, 'incomplete'],
  ] as const) {
    await assert.rejects(reconcileRlm('Explain', { workspace, structure, arms, reserved_tokens: 200000, model, ...overrides } as RlmReconcileOptions), error => error instanceof RlmReconcileError && error.code === code && error.remedy.length > 0);
  }
  assert.equal(model.requests.length, 0);
  assert.equal((await client.listAllComplete()).items.length, before);
});

test('paired validation rejects malformed and oversized declarations with remedies', async t => {
  const { workspace } = await tracker(t);
  for (const value of [null, [], [{}], [{ groups: [], budget_tokens: 100 }, arms[1]], [{ ...arms[0], extra: true }, arms[1]], [{ groups: [null], budget_tokens: 100 }, arms[1]], [{ groups: [[]], budget_tokens: 100 }, arms[1]], [{ groups: [['unknown']], budget_tokens: 100 }, arms[1]], [{ groups: [['title', 'title']], budget_tokens: 100 }, arms[1]], [{ groups: [['title']], budget_tokens: 100 }, arms[1]], [{ ...arms[0], budget_tokens: 0 }, arms[1]]]) {
    assert.throws(() => parseReconcileArms(value, ['title', 'status']), error => error instanceof RlmReconcileError && error.code === 'invalid' && error.remedy.length > 0);
  }
  await assert.rejects(reconcileRlm('Question', null as unknown as RlmReconcileOptions), { code: 'incomplete' });
  for (const question of ['', ' ', 'x'.repeat(4097), null]) await assert.rejects(reconcileRlm(question as string, { workspace, structure, arms, reserved_tokens: 200000 }), { code: 'invalid' });
  await assert.rejects(reconcileRlm('Question', { workspace, structure: [], arms, reserved_tokens: 200000 }), { code: 'invalid' });
});

test('paired failures preserve pending costs and leave later arms their reservations', async t => {
  const { workspace, client } = await tracker(t);
  for (const failure of [new RlmError('model', 'private diagnostics'), new Error('private diagnostics')]) {
    const model = new ScriptedModel((_request, index) => { if (index === 0) throw failure; return unknown(_request); });
    const report = await reconcileRlm('Explain', { workspace, structure, arms, reserved_tokens: 200000, model });
    assert.equal(report.status, 'partial');
    assert.equal(report.arms[0].groups[0].refusal?.code, 'model');
    assert.ok(report.arms[0].charged > 0 && report.arms[0].charged <= 100000);
    assert.equal(report.arms[1].groups.length, 2);
    assert.ok(report.comparisons.every(entry => entry.relation === 'unresolved'));
    const state = await new RlmLedger(workspace).load(report.arms[0].groups[0].run);
    assert.equal(state.calls[0].failure?.code, 'model');
    assert.equal(JSON.stringify(report).includes('private diagnostics'), false);
    assert.ok((await client.listAllComplete()).items.every(item => item.assignee === undefined));
  }
});

test('paired history refusal is replayable and recursive calls share the global cap', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'History source' })).item.id;
  const model = new ScriptedModel(request => {
    const current = state(request);
    if (current.transcript.length === 0) return JSON.stringify({ action: 'history', id, start: 0, end: 10 });
    if (current.transcript.length === 1) return JSON.stringify({ action: 'spawn', subgoal: current.question, slice: { fragments: [], estimated_tokens: 2 } });
    return unknown(request);
  });
  const report = await reconcileRlm('Explain', { workspace, structure, arms, reserved_tokens: 200000, model, settings: { max_calls: 3 } });
  assert.equal(report.arms.flatMap(arm => arm.groups).reduce((sum, group) => sum + group.calls, 0), 3);
  for (const group of report.arms.flatMap(arm => arm.groups)) {
    const state = await new RlmLedger(workspace).load(group.run);
    assert.equal((state.calls[0].steps[0].observation as { refused: string }).refused, 'evidence');
    assert.equal((state.calls[0].steps[1].observation as { refused: string }).refused, 'calls');
    await replayRlm(workspace, group.run);
  }
});

/** Execute the native host asynchronously so the HTTP fixture can serve both arms. */
async function native(root: string, workspace: string, plan: string, json: boolean): Promise<string> {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', 'reconcile', 'Explain', '--plan', plan, '--budget-tokens', '200000', ...(json ? ['--json'] : [])], { cwd: root, env: { ...process.env, PM_PATH: workspace }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { try { assert.equal(code, 0, stderr); resolve(stdout); } catch (error) { reject(error); } }); });
}

test('paired native CLI emits compact TOON and JSON with typed input refusals', async t => {
  const { workspace, root, client } = await tracker(t);
  const id = (await client.create({ title: 'Native source' })).item.id;
  let requests = 0;
  const { endpoint } = await httpFixture(t, async (request, response) => {
    requests++;
    const body = await requestBody(request);
    response.end(JSON.stringify({ response: pairedResponse({ prompt: body.prompt as string, max_output_tokens: 512, context_tokens: 32768 }, id), prompt_eval_count: 50, eval_count: 20 }));
  });
  await writeRlmSettings(workspace, { endpoint }, 'rlm-test');
  const extension = join(workspace, 'extensions', 'pm-rlm');
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ entry: 'entry.js', capabilities: ['commands', 'schema'], version: '2026.10.18', name: 'pm-rlm' }));
  const entryUrl = new URL('../index.ts', import.meta.url);
  await writeFile(join(extension, 'entry.js'), `export { default } from ${JSON.stringify(entryUrl.href)};`);
  const plan = JSON.stringify({ structure, arms });
  for (const json of [true, false]) {
    const output = await native(root, workspace, plan, json);
    const result = (json ? JSON.parse(output) : decodeToon(output)) as RlmReconcileResult;
    assert.equal(result.status, 'complete');
    assert.equal(result.comparisons[0].relation, 'disagreement');
    assert.ok(Buffer.byteLength(output) < 9000);
  }
  assert.equal(requests, 12);
  const ctx = { command: 'rlm reconcile', pm_root: workspace, args: ['Explain'], options: { plan, budgetTokens: '200000' }, global: {} } as CommandHandlerContext;
  for (const options of [{ ...ctx.options, plan: '{' }, { ...ctx.options, plan: 'null' }, { ...ctx.options, budgetTokens: undefined }, { ...ctx.options, budgetTokens: '1' }]) await assert.rejects(runCommand('reconcile', { ...ctx, options }), /remedy:/);
});


test('paired nested runs retain native recursive replay and exact exhaustion charges', async t => {
  const { workspace } = await tracker(t);
  const nested = new ScriptedModel(request => {
    const current = state(request);
    const canDescend = current.depth === 0 && current.transcript.length === 0;
    if (canDescend) return JSON.stringify({ slice: { estimated_tokens: 2, fragments: [] }, subgoal: current.question, action: 'spawn' });
    return unknown(request);
  });
  const report = await reconcileRlm('Explain', { workspace, structure, arms, reserved_tokens: 200000, source_workspace: workspace, author: 'rlm-test', model: nested, settings: { max_calls: 6 } });
  for (const group of report.arms.flatMap(arm => arm.groups)) {
    assert.equal(group.calls, 2);
    assert.deepEqual((await replayRlm(workspace, group.run)).components, group.components);
  }
  const spinning = new ScriptedModel(() => '{"action":"count","filter":{}}');
  const tight: RlmReconcileOptions['arms'] = arms.map(arm => ({ ...arm, budget_tokens: 30000 })) as RlmReconcileOptions['arms'];
  const exhausted = await reconcileRlm('Explain', { workspace, structure, arms: tight, reserved_tokens: 60000, model: spinning });
  assert.equal(exhausted.status, 'partial');
  assert.ok(exhausted.arms.every(arm => arm.charged <= 30000));
  assert.ok(exhausted.arms.flatMap(arm => arm.groups).every(group => group.refusal?.code === 'budget'));
  assert.equal(exhausted.budget.charged, exhausted.arms.reduce((sum, arm) => sum + arm.charged, 0));
});

/** The public failure receipt names terminal calls that a concurrent resume completed first. */
test('paired cleanup reports skipped competing completion without changing its ledger', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel((request, index) => {
    if (index === 0) throw new RlmError('model', 'Initial inference stopped');
    return unknown(request);
  });
  const fail = RlmLedger.prototype.failUnfinished;
  let completed: RlmState | undefined;
  t.mock.method(RlmLedger.prototype, 'failUnfinished', async function (this: RlmLedger, run: string, failure: NonNullable<RlmCall['failure']>) {
    await resumeRlm(workspace, run, model);
    completed = await new RlmLedger(workspace).load(run);
    return fail.call(this, run, failure);
  });
  const report = await reconcileRlm('Explain', { workspace, structure, arms, reserved_tokens: 200000, model });
  const group = report.arms[0].groups[0];
  assert.ok(completed);
  assert.deepEqual(group.cleanup_skipped, [group.run]);
  assert.deepEqual(await new RlmLedger(workspace).load(group.run), completed);
  assert.equal(group.charged, completed.reserved_tokens);
  assert.ok(completed.calls[0].result !== undefined);
  assert.equal(completed.calls[0].failure, undefined);
});
