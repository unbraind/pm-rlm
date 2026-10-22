import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { runRlm, replayRlm, resumeRlm, evidenceRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import { RlmError } from '../src/errors.ts';
import { parseComponents, sourceWitness, validateAnswer, RlmEvidenceError } from '../src/evidence.ts';
import { runCommand } from '../src/commands.ts';
import { compatibleAction, acceptsSchema, ACTION_SCHEMA } from '../src/action-schema.ts';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import type { RlmAnswerComponent, RlmResult, RlmState, RlmItem } from '../src/types.ts';
import { httpFixture, requestBody } from './http.ts';
import { writeRlmSettings } from '../src/settings.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Construct a component without optional evidence ambiguities. */
function component(status: RlmAnswerComponent['status'], witnesses: RlmAnswerComponent['witnesses'] = []): RlmAnswerComponent {
  return { component: 'title', status, answer: status === 'supported' ? 'source title' : '', reason: status === 'supported' ? '' : 'No source establishes this part', witnesses };
}
/** Extract only the engine state line, leaving protocol examples out of JSON parsing. */
function promptState(prompt: string): { transcript: { observation: { data: { digest: string } } }[] } {
  return JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { transcript: { observation: { data: { digest: string } } }[] };
}
/** Produce a supported answer using an actual source witness returned by the engine. */
async function supportedRun(workspace: string, id: string, source_workspace?: string) {
  const model = new ScriptedModel((request, index) => index === 0 ? JSON.stringify({ action: 'witness', id, start: 0, end: 20 }) : JSON.stringify({ action: 'answer', components: [component('supported', [{ step: 0, digest: promptState(request.prompt).transcript[0].observation.data.digest }])] }));
  const run = await runRlm('What title is witnessed?', { workspace, source_workspace, components: ['title'], scope: { ids: [id] }, model });
  return { run, model };
}
/** Positive validation refusals must become assertion failures in behavioral revert proofs. */
async function verifyUnknownRun(workspace: string, run: RlmResult, model: ScriptedModel): Promise<void> {
  await assert.doesNotReject(async () => {
    assert.deepEqual(await replayRlm(workspace, run.run), run);
    assert.deepEqual(await evidenceRlm(workspace, run.run), { run: run.run, verified: true, total: 1, supported: 0, unsupported: 0, unknown: 1, components: [component('unknown')] });
    assert.deepEqual(await resumeRlm(workspace, run.run, model), run);
  });
}

test('evidence works in a non-git tracker with no git executable and zero validation inference', async t => {
  const { workspace, root, client } = await tracker(t);
  const id = (await client.create({ title: 'Public synthetic source' })).item.id;
  const priorPath = process.env.PATH;
  const priorCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = root;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; if (priorCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = priorCeiling; });
  const { run, model } = await supportedRun(workspace, id);
  assert.equal(model.requests.length, 2);
  const before = JSON.stringify((await client.listAllComplete({ includeBody: true })).items);
  const report = await evidenceRlm(workspace, run.run);
  assert.deepEqual(report, { run: run.run, verified: true, total: 1, supported: 1, unsupported: 0, unknown: 0, components: run.components });
  assert.deepEqual(await replayRlm(workspace, run.run), run);
  assert.equal(JSON.stringify((await client.listAllComplete({ includeBody: true })).items), before);
  assert.deepEqual(await resumeRlm(workspace, run.run, model), run);
  assert.equal(model.requests.length, 2);
  assert.equal(run.components?.[0].witnesses.length, 1);
  assert.equal(run.answer, JSON.stringify(run.components));
  // Exercise native host TOON and JSON rendering without putting git on PATH.
  const extension = join(workspace, 'extensions', 'pm-rlm');
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ name: 'pm-rlm', version: '2026.10.18', entry: 'entry.js', capabilities: ['commands', 'schema'] }));
  await writeFile(join(extension, 'entry.js'), `export { default } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};`);
  for (const json of [false, true]) {
    const execution = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', 'evidence', run.run, ...(json ? ['--json'] : [])], { cwd: root, encoding: 'utf8', env: { ...process.env, PM_PATH: workspace } });
    assert.equal(execution.status, 0, execution.stderr);
    const decoded = (json ? JSON.parse(execution.stdout) : decodeToon(execution.stdout)) as typeof report;
    assert.deepEqual(decoded, report);
    assert.ok(Buffer.byteLength(execution.stdout) < 1500);
  }
});

test('omitted witnesses and legacy finish cannot support declared components', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Unrelated source' });
  const model = new ScriptedModel((_request, index) => index === 0 ? '{"action":"finish","answer":"unsupported assertion"}' : JSON.stringify({ action: 'answer', components: [component(index === 1 ? 'supported' : 'unknown')] }));
  const run = await runRlm('Title?', { workspace, components: ['title'], model });
  assert.equal(run.components?.[0].status, 'unknown');
  assert.equal(model.requests.length, 3);
  const state = await new RlmLedger(workspace).load(run.run);
  for (const step of state.calls[0].steps.slice(0, 2)) {
    assert.equal((step.observation as { refused: string }).refused, 'evidence');
    assert.ok((step.observation as { remedy: string }).remedy.length > 0);
  }
  assert.deepEqual(await replayRlm(workspace, run.run), run);
});

/** Failed children retain typed terminal evidence without pretending to return component answers. */
test('successful recursive calls cover components while typed child refusals stay terminal', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Synthetic recursive source' });
  const model = new ScriptedModel((_request, index) => {
    if (index === 0) return '{"action":"partition","filter":{},"maxTokens":4096}';
    if (index === 1) return '{"action":"spawn","subgoal":"Read source","slice":{"partition_step":0,"index":0}}';
    if (index === 2) throw new RlmError('model', 'Synthetic child model refusal');
    return JSON.stringify({ action: 'answer', components: [component('unknown')] });
  });
  const run = await runRlm('Title?', { workspace, components: ['title'], model });
  const state = await new RlmLedger(workspace).load(run.run);
  assert.deepEqual(run.components, [component('unknown')]);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].result, undefined);
  assert.deepEqual(state.calls[1].failure, { code: 'model', reason: 'Synthetic child model refusal' });
  assert.deepEqual(await replayRlm(workspace, run.run), run);
  assert.deepEqual(await resumeRlm(workspace, run.run, model), run);
  assert.equal(model.requests.length, 4);
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Every successfully completed recursive call\s+returns each declared component exactly once, in declaration order/);
  assert.match(readme, /A call that terminates in a typed refusal before producing an answer returns no\s+components/);
  assert.match(readme, /Legacy runs without declarations keep\s+the execution-only contract/);
});

/** Every refusal path authenticates corrective text before validation can reuse a ledger. */
for (const scenario of [
  { name: 'component', output: '{"action":"finish","answer":"unchecked"}', evidence: true },
  { name: 'witness', output: '{"action":"witness","id":"absent","start":0,"end":1}', evidence: true },
  { name: 'plain tool', output: '{"action":"get","id":"absent","fields":["title"]}', evidence: false },
  { name: 'parse', output: 'not a JSON action', evidence: false },
]) test(`recorded ${scenario.name} refusal remedy integrity`, async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel((_request, index) => index === 0 ? scenario.output : JSON.stringify({ action: 'answer', components: [component('unknown')] }));
  const run = await runRlm('Title?', { workspace, components: ['title'], model });
  const ledger = new RlmLedger(workspace);
  const original = await ledger.load(run.run);
  const refusal = original.calls[0].steps[0].observation as { remedy?: unknown };
  assert.equal(typeof refusal.remedy, scenario.evidence ? 'string' : 'undefined');
  await verifyUnknownRun(workspace, run, model);
  assert.equal(model.requests.length, 2);
  const paths = [join(workspace, 'tasks', `${run.run}.toon`), join(workspace, 'history', `${run.run}.jsonl`)];
  for (const unfinished of [false, true]) for (const remedy of scenario.evidence ? ['forged corrective text', undefined, 42] : ['forged corrective text', null, 42]) {
    const tampered = structuredClone(original);
    const observation = tampered.calls[0].steps[0].observation as { remedy?: unknown };
    if (remedy === undefined) delete observation.remedy;
    else observation.remedy = remedy;
    if (unfinished) { delete tampered.calls[0].result; tampered.calls[0].steps.pop(); }
    await ledger.save(tampered);
    const before = await Promise.all(paths.map(path => readFile(path)));
    await assert.rejects(replayRlm(workspace, run.run), { code: 'replay' });
    await assert.rejects(evidenceRlm(workspace, run.run), { code: 'replay' });
    const noInference = new ScriptedModel(() => assert.fail('Tampered remedy must be refused before inference'));
    await assert.rejects(resumeRlm(workspace, run.run, noInference), { code: 'replay' });
    assert.equal(noInference.requests.length, 0);
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
  }
});

/** Terminal child receipts must preserve remedies for replay and failed-call reuse. */
for (const hook of [false, true]) test(`child ${hook ? 'completion' : 'model'} evidence remedy survives replay and reuse`, async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Synthetic terminal receipt source' });
  const remedy = 'Request a source witness before answering';
  const model = new ScriptedModel((_request, index) => {
    if (index === 0) return '{"action":"partition","filter":{},"maxTokens":4096}';
    if (index === 1 || index === 3) return '{"action":"spawn","subgoal":"Read source","slice":{"partition_step":0,"index":0}}';
    if (index === 2 && !hook) throw new RlmEvidenceError('Synthetic child evidence refusal', remedy);
    return JSON.stringify({ action: 'answer', components: [component('unknown')] });
  });
  const run = await runRlm('Title?', { workspace, components: ['title'], model, on_call_complete: call => {
    if (hook && call.depth === 1) throw new RlmEvidenceError('Synthetic child evidence refusal', remedy);
  } });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(run.run);
  const receipt = hook ? 'completion_refusal' : 'failure';
  assert.deepEqual(state.calls[1][receipt], { code: 'evidence', reason: 'Synthetic child evidence refusal', remedy });
  assert.equal(state.calls[1].result, hook ? JSON.stringify([component('unknown')]) : undefined);
  assert.equal((state.calls[0].steps[1].observation as { remedy: string }).remedy, remedy);
  if (!hook) assert.equal((state.calls[0].steps[2].observation as { remedy: string }).remedy, remedy);
  await verifyUnknownRun(workspace, run, model);
  assert.equal(model.requests.length, 5);
  for (const value of [42, null, 'non-evidence code']) {
    const malformed = structuredClone(state);
    const refusal = malformed.calls[1][receipt] as unknown as { code: string; remedy: unknown };
    if (value === 'non-evidence code') refusal.code = 'model';
    else refusal.remedy = value;
    await ledger.save(malformed);
    await assert.rejects(ledger.load(run.run), { code: 'incomplete' });
  }
  const tampered = structuredClone(state);
  (tampered.calls[0].steps[1].observation as { remedy: string }).remedy = 'forged corrective text';
  await ledger.save(tampered);
  await assert.rejects(replayRlm(workspace, run.run), { code: 'replay' });
});

test('recursive children inherit declarations and cannot lend a parent their witness steps', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'Recursive source' })).item.id;
  const model = new ScriptedModel((request, index) => {
    assert.match(request.prompt, /Declared components: \["title"\]/);
    if (index === 0) return '{"action":"partition","filter":{},"maxTokens":4096}';
    if (index === 1) return '{"action":"spawn","subgoal":"Read source","slice":{"partition_step":0,"index":0}}';
    if (index === 2) return JSON.stringify({ action: 'witness', id, start: 0, end: 20 });
    if (index === 3) return JSON.stringify({ action: 'answer', components: [component('supported', [{ step: 0, digest: promptState(request.prompt).transcript[0].observation.data.digest }])] });
    return JSON.stringify({ action: 'answer', components: [component(index === 4 ? 'supported' : 'unsupported', index === 4 ? [{ step: 1, digest: 'a'.repeat(64) }] : [])] });
  });
  const run = await runRlm('Title?', { workspace, scope: { ids: [id] }, components: ['title'], model });
  assert.equal(run.calls, 2); assert.equal(run.components?.[0].status, 'unsupported');
  assert.equal((await evidenceRlm(workspace, run.run)).unsupported, 1);
  assert.deepEqual(await replayRlm(workspace, run.run), run);
});

test('replay verifies every witness digest including uncited source witnesses', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'Digest source' })).item.id;
  const { run } = await supportedRun(workspace, id);
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(run.run);
  for (const mutate of [
    (copy: RlmState) => { (copy.calls[0].steps[0].observation as { data: { digest: string } }).data.digest = 'a'.repeat(64); },
    (copy: RlmState) => { copy.calls[0].steps[0].observation = undefined; },
    (copy: RlmState) => { copy.calls[0].steps[0].observation = null; },
    (copy: RlmState) => { copy.calls[0].steps[0].observation = 'invalid'; },
    (copy: RlmState) => { copy.calls[0].steps[1].observation = {}; },
    (copy: RlmState) => { copy.calls[0].steps = []; },
    (copy: RlmState) => { copy.calls[0].steps[1].response!.text = JSON.stringify({ action: 'answer', components: [] }); },
    (copy: RlmState) => { copy.calls[0].result = 'unchecked prose'; },
  ]) {
    const copy = structuredClone(state); mutate(copy); await ledger.save(copy);
    await assert.rejects(replayRlm(workspace, run.run));
    await assert.rejects(resumeRlm(workspace, run.run, new ScriptedModel(() => { throw new Error('Must never infer'); })));
  }
  const uncited = structuredClone(state);
  const unknown = [component('unknown')];
  uncited.calls[0].steps[1].response!.text = JSON.stringify({ action: 'answer', components: unknown });
  uncited.calls[0].result = JSON.stringify(unknown);
  (uncited.calls[0].steps[0].observation as { data: { text: string } }).data.text = 'changed';
  await ledger.save(uncited);
  await assert.rejects(replayRlm(workspace, run.run), { code: 'replay' });
  delete uncited.calls[0].steps[0].observation;
  await ledger.save(uncited);
  await assert.rejects(resumeRlm(workspace, run.run, new ScriptedModel(() => { throw new Error('Must not infer'); })), { code: 'replay' });
});

test('coverage bounds refuse malformed declarations and source ranges with remedies', () => {
  for (const input of [null, [], Array(17).fill('x'), ['x', 'x'], [' '], [1], ['x'.repeat(257)]]) assert.throws(() => parseComponents(input), RlmEvidenceError);
  assert.deepEqual(parseComponents(['title']), ['title']);
  const items = [{ id: 'source', title: '🙂'.repeat(400) }] as RlmItem[];
  for (const [id, start, end] of [['missing', 0, 1], ['source', -1, 1], ['source', 0.5, 1], ['source', 0, 0], ['source', 2, 1], ['source', 0, 9000], ['source', 0, 800]] as const) assert.throws(() => sourceWitness(items, id, start, end), RlmEvidenceError);
  assert.equal(sourceWitness(items, 'source', 0, 20).text, JSON.stringify(items[0]).slice(0, 20));
});

test('component validator rejects missing, extra, forged, future and malformed evidence', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'Validator source' })).item.id;
  const { run } = await supportedRun(workspace, id);
  const state = await new RlmLedger(workspace).load(run.run);
  const valid = run.components!;
  const check = (entries: unknown, current = state, before = 1) => validateAnswer(current, current.calls[0], entries as RlmAnswerComponent[], before);
  assert.equal(check(valid), run.answer);
  for (const entries of [[], [...valid, ...valid], [{ ...valid[0], component: 'other' }], [{ ...valid[0], answer: 'x'.repeat(32769) }], [{ ...valid[0], status: 'invented' }], [{ ...valid[0], answer: 1 }], [{ ...valid[0], reason: 1 }], [{ ...valid[0], witnesses: null }], [{ ...valid[0], witnesses: Array(9).fill(valid[0].witnesses[0]) }], [component('unknown', valid[0].witnesses)], [{ ...component('unknown'), answer: 'claim' }], [{ ...component('unknown'), reason: ' ' }], [component('supported')], [{ ...valid[0], answer: ' ' }], [{ ...valid[0], reason: 'extra' }]]) assert.throws(() => check(entries), RlmEvidenceError);
  for (const witnesses of [[{ step: -1, digest: 'a' }], [{ step: 1, digest: 'a' }], [...valid[0].witnesses, ...valid[0].witnesses], [{ step: 0, digest: 'a' }]]) assert.throws(() => check([{ ...valid[0], witnesses }]), RlmEvidenceError);
  for (const mutate of [
    (copy: RlmState) => { delete copy.components; },
    (copy: RlmState) => { copy.calls[0].steps = []; },
    (copy: RlmState) => { delete copy.calls[0].steps[0].observation; },
    (copy: RlmState) => { copy.calls[0].steps[0].observation = {}; },
    (copy: RlmState) => { copy.calls[0].steps[0].observation = { data: {} }; },
    (copy: RlmState) => { delete copy.calls[0].steps[0].response; },
    (copy: RlmState) => { copy.calls[0].steps[0].observation = { data: { ...sourceWitness(copy.snapshot, id, 0, 20), digest: 'a'.repeat(64) } }; },
    (copy: RlmState) => { copy.calls[0].steps[0].response!.text = '{"action":"finish","answer":"unrelated"}'; },
    (copy: RlmState) => { (copy.calls[0].steps[0].observation as { data: { text: string } }).data.text = 'changed'; },
  ]) { const copy = structuredClone(state); mutate(copy); assert.throws(() => check(valid, copy), RlmEvidenceError); }
  const legacyParser = structuredClone(state); delete legacyParser.parser_version;
  assert.throws(() => check(valid, legacyParser), { code: 'invalid' });
  const wrapped = structuredClone(state); wrapped.calls[0].steps[0].response!.text = '```json\n' + state.calls[0].steps[0].response!.text + '\n```';
  assert.equal(check(valid, wrapped), run.answer);
  assert.equal(check([component('unsupported')]), JSON.stringify([component('unsupported')]));
});

test('coverage CLI refuses execution-only runs and invalid component declarations', async t => {
  const { workspace } = await tracker(t);
  const ctx = { command: 'rlm run', pm_root: workspace, args: ['Question'], options: { components: '[]' }, global: {} } as CommandHandlerContext;
  await assert.rejects(runCommand('run', ctx), /remedy:/);
  await assert.rejects(runCommand('run', { ...ctx, options: { components: '[' } }), /Invalid --components JSON; remedy:/);
  const legacy = await runRlm('Legacy', { workspace, model: new ScriptedModel(() => '{"action":"finish","answer":"legacy"}') });
  await assert.rejects(evidenceRlm(workspace, legacy.run), RlmEvidenceError);
  await assert.rejects(runCommand('evidence', { ...ctx, args: [legacy.run] }), /remedy:/);
  const unknown = new ScriptedModel(() => JSON.stringify({ action: 'answer', components: [component('unknown')] }));
  const run = await runRlm('Unknown', { workspace, components: ['title'], model: unknown });
  assert.equal((await evidenceRlm(workspace, run.run)).unknown, 1);
  const state = await new RlmLedger(workspace).load(run.run);
  state.components = [];
  await new RlmLedger(workspace).save(state);
  await assert.rejects(replayRlm(workspace, run.run), { code: 'incomplete' });
});

test('new evidence actions share local and strict compatible transport schemas', () => {
  const action = { action: 'answer', components: [component('unknown')] };
  assert.equal(acceptsSchema(ACTION_SCHEMA, action), true);
  assert.deepEqual(JSON.parse(compatibleAction(JSON.stringify({ response: action }))), action);
  assert.equal(acceptsSchema(ACTION_SCHEMA, { action: 'witness', id: 'source', start: 0, end: 10 }), true);
  assert.equal(acceptsSchema(ACTION_SCHEMA, { ...action, extra: 'forbidden' }), false);
});


test('read-only source tracker stays byte-for-byte unchanged while a separate ledger records coverage', async t => {
  const source = await tracker(t);
  const ledger = await tracker(t);
  const item = (await source.client.create({ title: 'Read-only public source' })).item;
  const before = JSON.stringify((await source.client.listAllComplete({ includeBody: true })).items);
  const { run } = await supportedRun(ledger.workspace, item.id, source.workspace);
  assert.equal((await evidenceRlm(ledger.workspace, run.run)).supported, 1);
  assert.equal(JSON.stringify((await source.client.listAllComplete({ includeBody: true })).items), before);
});

test('evidence recovery reuses pending source and completion responses without inference', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'Recovery source' })).item.id;
  const { run, model } = await supportedRun(workspace, id);
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(run.run);
  for (const pendingWitness of [true, false]) {
    const copy = structuredClone(state);
    delete copy.calls[0].result;
    if (pendingWitness) {
      copy.reserved_tokens -= (copy.calls[0].steps[0].observation as { estimated_tokens: number }).estimated_tokens;
      delete copy.calls[0].steps[0].observation;
    }
    await ledger.save(copy);
    assert.deepEqual(await resumeRlm(workspace, run.run, model), run);
    assert.equal(model.requests.length, 2);
  }
});

test('witness scope refusals and component refusals replay without a model retry', async t => {
  const { workspace } = await tracker(t);
  const model = new ScriptedModel((_request, index) => index === 0 ? '{"action":"witness","id":"absent","start":0,"end":20}' : JSON.stringify({ action: 'answer', components: [component('unknown')] }));
  const run = await runRlm('Title?', { workspace, components: ['title'], model });
  assert.deepEqual(await replayRlm(workspace, run.run), run);
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(run.run);
  const bad = structuredClone(state);
  (bad.calls[0].steps[0].observation as { reason: string }).reason = 'forged';
  await ledger.save(bad);
  await assert.rejects(replayRlm(workspace, run.run), { code: 'replay' });
  const refused = structuredClone(state);
  refused.calls[0].steps[1].observation = { refused: 'evidence', reason: 'invented' };
  await ledger.save(refused);
  await assert.rejects(replayRlm(workspace, run.run), { code: 'replay' });
  // Refuse answer actions on legacy runs, then allow the recorded legacy finish.
  const legacy = new ScriptedModel((_request, index) => index === 0 ? JSON.stringify({ action: 'answer', components: [component('unknown')] }) : '{"action":"finish","answer":"legacy"}');
  const oldRun = await runRlm('Legacy', { workspace, model: legacy });
  assert.equal(oldRun.answer, 'legacy');
  assert.deepEqual(await replayRlm(workspace, oldRun.run), oldRun);
  // A valid refusal reason must still be required when the refusal code is intact.
  const malformed = await ledger.load(oldRun.run);
  delete (malformed.calls[0].steps[0].observation as { reason?: string }).reason;
  await ledger.save(malformed);
  await assert.rejects(replayRlm(workspace, oldRun.run), { code: 'replay' });
});


test('native run and evidence commands make exactly the two visible HTTP model requests', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'HTTP source' })).item.id;
  let requests = 0;
  const { endpoint } = await httpFixture(t, async (request, response) => {
    const body = await requestBody(request);
    const prompt = body.prompt as string;
    const action = requests++ === 0 ? { action: 'witness', id, start: 0, end: 20 } : { action: 'answer', components: [component('supported', [{ step: 0, digest: promptState(prompt).transcript[0].observation.data.digest }])] };
    response.end(JSON.stringify({ response: JSON.stringify(action), prompt_eval_count: 50, eval_count: 20 }));
  });
  await writeRlmSettings(workspace, { endpoint }, 'rlm-test');
  const context = { command: 'rlm run', pm_root: workspace, args: ['Title?'], options: { components: '["title"]', scope: JSON.stringify({ ids: [id] }) }, global: { author: 'rlm-test' } } as CommandHandlerContext;
  const run = await runCommand('run', context);
  const report = await runCommand('evidence', { ...context, args: [String(run.run)] });
  assert.equal(report.supported, 1);
  await replayRlm(workspace, String(run.run));
  await resumeRlm(workspace, String(run.run));
  assert.equal(requests, 2);
});

test('bounded source observations consume the recorded remaining budget', async t => {
  const { workspace, client } = await tracker(t);
  const id = (await client.create({ title: 'Budget source' })).item.id;
  const { run } = await supportedRun(workspace, id);
  const state = await new RlmLedger(workspace).load(run.run);
  const budget = Buffer.byteLength(state.calls[0].steps[0].prompt) + 64 * 16;
  let requests = 0;
  await assert.rejects(runRlm('What title is witnessed?', { workspace, scope: { ids: [id] }, components: ['title'], settings: { budget_tokens: budget, output_tokens: 64 }, model: { name: 'budget-fixture', complete: async () => { requests++; return { text: JSON.stringify({ action: 'witness', id, start: 0, end: 20 }), tokens_in: budget - 1, tokens_out: 0 }; } } }), { code: 'budget' });
  assert.equal(requests, 1);
  const roots = (await client.listAllComplete()).items.filter(item => typeof item.rlm_state === 'string' && item.id !== run.run);
  assert.equal(roots.length, 1);
  const refused = await new RlmLedger(workspace).load(roots[0].id);
  assert.equal((refused.calls[0].steps[0].observation as { refused: string }).refused, 'budget');
  await assert.rejects(replayRlm(workspace, roots[0].id), { code: 'replay' });
});
