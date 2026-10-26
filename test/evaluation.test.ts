import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { testEnvironment } from '../scripts/environment.ts';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { evalDigest, evaluateRlm, parseEvalSuite, truncatedEvalPrompt } from '../src/evaluation.ts';
import { readCorpus } from '../src/environment.ts';
import { readRlmSettings } from '../src/settings.ts';
import { RlmError } from '../src/errors.ts';
import type { RlmEvalBoundary, RlmEvalOptions, RlmEvalResult, RlmEvalSuite } from '../src/evaluation-types.ts';
import { httpFixture, requestBody } from './http.ts';
import { ScriptedModel, tracker, killAtCheckpoint, installExtension } from './helpers.ts';
import { runCommand } from '../src/commands.ts';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';

/** Build twenty exact tasks over one real SDK tracker without Git. */
export async function fixture(t: Parameters<typeof tracker>[0]) {
  const source = await tracker(t);
  await source.client.create({ id: 'public-task', type: 'Task', title: 'Public task', description: 'x'.repeat(10000) });
  const items = (await readCorpus(source.workspace)).items;
  const suite: RlmEvalSuite = { version: 1, id: 'fixture-v1', sources: [{ id: 'sample', repository: 'fixture/public', revision: 'a'.repeat(40), corpus_sha256: evalDigest(JSON.stringify(items)) }], questions: Array.from({ length: 20 }, (_, index) => ({ id: `q${index}`, source: 'sample', question: 'How many tracker items exist?', gold: '1' })) };
  const target = await tracker(t);
  const model = new ScriptedModel(request => request.response_kind === 'answer' ? '{"answer":"1"}' : '{"action":"finish","answer":"1"}');
  const options: RlmEvalOptions = { workspace: target.workspace, sources: { sample: source.workspace }, id: 'trial', model: model.name, mode: 'stub', stub: model, full: true };
  return { source, target, suite, model, options };
}
/** Capture native host rendering with no Git executable or inherited test context. */
async function nativeEvaluation(target: { root: string; workspace: string }, file: string, sources: Record<string, string>, options: string[]): Promise<string> {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', 'eval', file, '--sources', JSON.stringify(sources), ...options], { cwd: target.root, env: { ...testEnvironment(process.env), PM_PATH: target.workspace, PATH: join(target.root, 'no-tools'), GIT_CEILING_DIRECTORIES: target.root } });
  let out = ''; let error = '';
  child.stdout.on('data', chunk => { out += String(chunk); }); child.stderr.on('data', chunk => { error += String(chunk); });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, error + out);
  return out;
}
/** Both arms share a model; completed receipts are reused and source bytes stay untouched. */
test('evaluation measures both arms and reuses completed receipts in a non-git tracker', async t => {
  const { source, target, suite, model, options } = await fixture(t);
  const before = JSON.stringify((await readCorpus(source.workspace)).items);
  const retained = { id: options.id, mode: options.mode, model: options.model, sources: { ...options.sources } };
  const pending = evaluateRlm(suite, options);
  Object.assign(options, { id: 'changed', mode: 'local', model: 'changed' });
  options.sources.sample = join(target.root, 'missing');
  let result!: RlmEvalResult;
  try { await assert.doesNotReject(async () => { result = await pending; }); }
  finally { Object.assign(options, retained); }
  assert.equal(result.status, 'complete');
  assert.equal(result.model, model.name);
  assert.equal(result.mode, 'stub');
  for (const arm of [result.summary.truncated, result.summary.recursive]) {
    assert.equal(arm.correct, 20); assert.equal(arm.accuracy, 1); assert.equal(arm.calls, 20);
    assert.equal(arm.children, 0); assert.equal(arm.unknown_children_arms, 0);
    assert.ok(arm.tokens! > 0); assert.ok(arm.wall_ms! >= 0); assert.equal(arm.failed_requests, 0);
  }
  assert.equal(model.requests.length, 40);
  assert.ok(result.rows!.every(row => row.visible_bytes < row.corpus_bytes));
  assert.equal(JSON.stringify((await readCorpus(source.workspace)).items), before);
  assert.equal((await target.client.listAllComplete()).items.length, 21);
  const reused = await evaluateRlm(suite, { ...options, full: false, stub: new ScriptedModel(() => { throw new Error('must not infer'); }) });
  assert.equal(reused.rows, undefined); assert.deepEqual(reused.summary, result.summary);
  assert.equal((await target.client.listAllComplete()).items.length, 21);
  await assert.rejects(evaluateRlm(suite, { ...options, settings: { max_calls: 5 } }), { code: 'invalid' });
});
/** Public input bounds reject malformed or ambiguous suites before side effects. */
test('evaluation validates suites, source boundaries, settings and typed remedies', async t => {
  const { suite, options, source } = await fixture(t);
  for (const value of [null, {}, { ...suite, version: 2 }, { ...suite, sources: [] }, { ...suite, sources: null }, { ...suite, questions: null }, { ...suite, questions: suite.questions.slice(0, 19) }, { ...suite, questions: Array(101).fill(suite.questions[0]) }, { ...suite, sources: [...suite.sources, suite.sources[0]] }, { ...suite, questions: Array(20).fill(suite.questions[0]) }]) assert.throws(() => parseEvalSuite(value), { code: 'invalid' });
  for (const change of [{ id: 'bad/source' }, { repository: '../bad' }, { revision: 'bad' }, { corpus_sha256: 'bad' }]) assert.throws(() => parseEvalSuite({ ...suite, sources: [{ ...suite.sources[0], ...change }] }), { code: 'invalid' });
  for (const change of [{ source: 'absent' }, { question: 'x'.repeat(4097) }, { gold: '' }]) assert.throws(() => parseEvalSuite({ ...suite, questions: suite.questions.map(row => ({ ...row, ...change })) }), { code: 'invalid' });
  await assert.rejects(evaluateRlm(suite, { ...options, id: '../bad' }), { code: 'invalid' });
  await assert.rejects(evaluateRlm(suite, { ...options, sources: {} }), { code: 'invalid' });
  await assert.rejects(evaluateRlm(suite, { ...options, mode: 'stub', stub: undefined }), { code: 'invalid' });
  await assert.rejects(evaluateRlm(suite, { ...options, stub: { name: 'wrong', complete: options.stub!.complete } }), { code: 'invalid' });
  await assert.rejects(evaluateRlm(suite, { ...options, settings: { context_tokens: 2 } }), { code: 'invalid', remedy: /./ });
  await source.client.update('public-task', { title: 'Changed copy' });
  await assert.rejects(evaluateRlm(suite, options), { code: 'incomplete', remedy: /Recreate/ });
  await assert.rejects(evaluateRlm(suite, { ...options, sources: { sample: join(source.root, 'missing') } }), { code: 'incomplete' });
});
/** Prefix truncation handles UTF-8 boundaries without exceeding the declared byte ceiling. */
test('evaluation truncation enforces byte limits and refuses oversized instructions', async t => {
  const { source } = await fixture(t);
  const settings = await readRlmSettings(source.workspace, { context_tokens: 1000, output_tokens: 100 });
  const corpus = (await readCorpus(source.workspace)).items;
  corpus[0].description = '💡'.repeat(300);
  for (let context = 500; context < 505; context++) {
    const prompt = truncatedEvalPrompt('count', corpus, { ...settings, context_tokens: context });
    assert.ok(Buffer.byteLength(prompt.prompt) + settings.output_tokens <= context);
    assert.ok(prompt.visible_bytes < prompt.corpus_bytes);
    assert.equal(prompt.prompt.includes('�'), false);
    assert.ok(prompt.prompt.endsWith(Buffer.from(JSON.stringify(corpus)).subarray(0, prompt.visible_bytes).toString('utf8')));
  }
  const full = truncatedEvalPrompt('count', corpus, { ...settings, context_tokens: 100000 });
  assert.equal(full.visible_bytes, full.corpus_bytes);
  const prefixBytes = Buffer.byteLength(truncatedEvalPrompt('count', [], settings).prompt) - 2;
  assert.equal(truncatedEvalPrompt('count', corpus, { ...settings, context_tokens: prefixBytes + settings.output_tokens }).visible_bytes, 0);
  assert.throws(() => truncatedEvalPrompt('x'.repeat(1000), corpus, settings), { code: 'budget' });
});
/** A preexisting record is foreign unless the package wrote its ownership marker. */
test('evaluation preserves foreign and malformed records with an explicit skip reason', async t => {
  const { suite, target, options } = await fixture(t);
  await target.client.create({ id: 'rlm-eval-trial', title: 'Foreign record', type: 'Task', description: 'foreign' });
  let result = await evaluateRlm(suite, options);
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'foreign_record_preserved');
  assert.equal((await target.client.get('rlm-eval-trial')).item.description, 'foreign');
  await target.client.update('rlm-eval-trial', { tags: 'rlm:evaluation', description: '{}' });
  result = await evaluateRlm(suite, options); assert.equal(result.status, 'skipped');
  for (const malformed of ['null', '[]', '{"owner":"pm-rlm/eval-v1"}', '{"owner":"pm-rlm/eval-v1","rows":[]}']) {
    await target.client.update('rlm-eval-trial', { description: malformed });
    assert.equal((await evaluateRlm(suite, options)).status, 'skipped');
  }
  assert.equal(result.summary.recursive.questions, 20); assert.equal(result.summary.recursive.correct, 0);
  for (const arm of [result.summary.truncated, result.summary.recursive]) {
    assert.equal(arm.children, null); assert.equal(arm.unknown_children_arms, 20);
    assert.equal(arm.calls, null); assert.equal(arm.failed_requests, null);
    assert.equal(arm.tokens, null); assert.equal(arm.wall_ms, null);
  }
});
/** Every transport failure stays in the denominator; unavailable usage remains unknown. */
test('evaluation counts malformed answers, model failures and failed recursive attempts honestly', async t => {
  const { suite, options, model } = await fixture(t);
  let requests = 0;
  model.complete = async () => { requests++; throw new RlmError('model', 'offline'); };
  const result = await evaluateRlm(suite, options);
  assert.equal(result.summary.truncated.correct, 0); assert.equal(result.summary.recursive.correct, 0);
  assert.equal(result.summary.truncated.calls, 20); assert.equal(result.summary.recursive.calls, 20);
  assert.equal(result.summary.truncated.tokens, null); assert.equal(result.summary.recursive.tokens, null);
  assert.equal(result.summary.truncated.failed_requests, 20); assert.equal(requests, 40);
  assert.equal(result.rows![0].truncated.tokens_in, null); assert.equal(result.rows![0].truncated.tokens_out, null);
  const bad = new ScriptedModel((request, index) => request.response_kind === 'answer' ? index === 0 ? '{"answer":}' : '{"answer":12}' : '{"action":"finish","answer":"wrong"}');
  const malformed = await evaluateRlm(suite, { ...options, id: 'bad-json', stub: bad });
  assert.equal(malformed.rows![0].truncated.refusal, 'incomplete');
  assert.equal(malformed.summary.truncated.correct, 0); assert.equal(malformed.summary.truncated.failed_requests, 0);
  assert.equal(malformed.summary.recursive.correct, 0);
});
/** Peer executors meet the lease at every boundary; a late native edit meets the CAS. */
test('evaluation interleaving at every durable boundary on one shared non-git tracker', async t => {
  const { suite, options, target, model } = await fixture(t);
  const boundaries = new Set<RlmEvalBoundary>();
  const peers: string[] = [];
  const result = await evaluateRlm(suite, { ...options, on_boundary: async step => {
    if (boundaries.has(step)) return;
    boundaries.add(step);
    try { await evaluateRlm(suite, options); peers.push('unexpected_success'); }
    catch (error) { peers.push((error as RlmError).code); }
    await target.client.create({ id: `foreign-${step.replaceAll('_', '-')}`, type: 'Task', title: 'Foreign peer record' });
  } });
  assert.equal(boundaries.size, 7); assert.deepEqual(peers, Array(7).fill('busy')); assert.equal(model.requests.length, 40);
  assert.deepEqual((await evaluateRlm(suite, options)).summary, result.summary);
  assert.equal((await target.client.listAllComplete()).items.filter(item => item.id.includes('-foreign-')).length, 7);
  const cas = { ...options, id: 'cas', on_boundary: async (step: RlmEvalBoundary) => { if (step === 'created') await target.client.update('rlm-eval-cas', { description: 'Peer replacement' }); } };
  await assert.rejects(evaluateRlm(suite, cas), { code: 'incomplete' });
  assert.equal((await target.client.get('rlm-eval-cas')).item.description, 'Peer replacement');
});
/** Fault every controller transition; reruns keep completed rows and never repeat pending inference. */
test('evaluation crash boundaries converge without duplicate records or lost completed rows', async t => {
  for (const boundary of ['leased', 'created', 'baseline_reserved', 'baseline_settled', 'recursive_reserved', 'row_settled', 'completed'] as const) {
    const { suite, options, target, model } = await fixture(t);
    const file = join(target.root, 'suite.json'); await writeFile(file, JSON.stringify(suite));
    const child = fork(join(import.meta.dirname, 'evaluation-crash.ts'), [target.workspace, file, boundary, JSON.stringify(options.sources)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: testEnvironment(process.env) });
    await killAtCheckpoint(t, child);
    const result = await evaluateRlm(suite, options);
    assert.equal(result.rows!.length, 20); assert.equal(new Set(result.rows!.map(row => row.id)).size, 20);
    const interrupted = ['baseline_reserved', 'baseline_settled', 'recursive_reserved'].includes(boundary);
    assert.equal((await target.client.listAllComplete()).items.length, interrupted ? 20 : 21);
    assert.equal(result.summary.recursive.correct, interrupted ? 19 : 20);
    if (interrupted) { assert.equal(result.rows![0].recursive.refusal, 'interrupted'); assert.equal(result.summary.recursive.tokens, null); assert.equal(result.summary.recursive.calls, null); assert.equal(result.summary.recursive.wall_ms, null); assert.equal(result.summary.recursive.failed_requests, null); }
    assert.equal(result.rows![0].recursive.children, interrupted ? null : 0);
    assert.equal(result.summary.recursive.children, interrupted ? null : 0);
    assert.equal(result.summary.recursive.unknown_children_arms, interrupted ? 1 : 0);
    assert.equal(result.summary.truncated.unknown_children_arms, boundary === 'baseline_reserved' ? 1 : 0);
    const calls = model.requests.length;
    assert.deepEqual((await evaluateRlm(suite, options)).summary, result.summary); assert.equal(model.requests.length, calls);
  }
});
/** Local-only admission and actual Ollama HTTP wire behavior use no SDK mocks. */
test('evaluation verifies local inventory and shares the actual HTTP model in both arms', async t => {
  const { suite, options } = await fixture(t);
  let generations = 0;
  const { endpoint } = await httpFixture(t, async (request, response) => {
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'fixture-local' }] })); return; }
    const body = await requestBody(request); generations++;
    assert.equal(body.model, 'fixture-local');
    const baseline = String(body.prompt).startsWith('Return ONLY JSON');
    response.end(JSON.stringify({ response: baseline ? '{"answer":"1"}' : '{"action":"finish","answer":"1"}', prompt_eval_count: 10, eval_count: 5 }));
  });
  const actual = { ...options, mode: undefined, stub: undefined, model: 'fixture-local', endpoint, author: undefined };
  const result = await evaluateRlm(suite, actual);
  assert.equal(result.mode, 'local'); assert.equal(result.summary.truncated.correct, 20); assert.equal(generations, 40);
  assert.equal(result.summary.recursive.tokens, 300);
  const ctx = { command: 'rlm eval', pm_root: options.workspace, args: [join(options.workspace, 'suite.json')], options: { sources: JSON.stringify(options.sources), id: 'trial', model: 'fixture-local', endpoint, full: true }, global: {} } as CommandHandlerContext;
  await writeFile(ctx.args[0], JSON.stringify(suite));
  const dispatched = await runCommand('eval', ctx);
  assert.deepEqual(dispatched.summary, result.summary);
  assert.equal((dispatched.rows as unknown[]).length, 20);
  for (const [index, change] of [{ endpoint: 'http://example.invalid' }, { endpoint: endpoint + '/v1' }, { model: 'fixture-cloud' }, { stub: options.stub }].entries()) await assert.rejects(evaluateRlm(suite, { ...actual, ...change, id: `refused-${index}` }), { code: 'model' });
  for (const [index, inventory] of [null, { models: [{ name: 'fixture-local', remote_host: 'remote' }] }, { models: [{ name: 'fixture-local', remote_model: 'remote' }] }, { models: [] }, {}].entries()) {
    const server = await httpFixture(t, (_request, response) => { response.end(JSON.stringify(inventory)); });
    await assert.rejects(evaluateRlm(suite, { ...actual, id: `inventory-${index}`, endpoint: server.endpoint }), { code: inventory === null ? 'invalid' : 'model' });
  }
  const denied = await httpFixture(t, (_request, response) => { response.statusCode = 503; response.end(); });
  await assert.rejects(evaluateRlm(suite, { ...actual, id: 'denied', endpoint: denied.endpoint }), { code: 'model' });
});
/** Native dispatch uses host rendering and gives remedies for unreadable or malformed inputs. */
test('evaluation native CLI command validates declarations and emits compact results', async t => {
  const { suite, options, target } = await fixture(t);
  const suiteFile = join(target.root, 'suite.json'); await writeFile(suiteFile, JSON.stringify(suite));
  const ctx = { command: 'rlm eval', pm_root: target.workspace, args: [suiteFile], options: { id: 'trial', sources: JSON.stringify(options.sources), model: options.model }, global: { author: 'rlm-test' } } as CommandHandlerContext;
  await evaluateRlm(suite, options);
  // The dispatcher reuses the receipt without network access; both were stub-mode boundaries.
  for (const sources of ['null', '[]', '{"sample":4}', '{']) await assert.rejects(runCommand('eval', { ...ctx, options: { ...ctx.options, sources } }), { exitCode: 2 });
  await assert.rejects(runCommand('eval', { ...ctx, args: [join(target.root, 'missing')] }), { exitCode: 2 });
  await assert.rejects(runCommand('eval', ctx), { exitCode: 2, message: /another configuration.*remedy/ });
  const source = (await readCorpus(options.sources.sample)).items;
  assert.equal(evalDigest(JSON.stringify(source)), suite.sources[0].corpus_sha256);
});

/** Real host renderers work with a PATH that has no Git executable. */
test('evaluation host emits native TOON and JSON without Git and preserves foreign data', async t => {
  const { target, suite, options } = await fixture(t);
  await installExtension(target.workspace);
  const file = join(target.root, 'suite.json'); await writeFile(file, JSON.stringify(suite));
  await target.client.create({ id: 'rlm-eval-trial', title: 'Foreign', type: 'Task' });
  for (const format of [[], ['--json']]) {
    const out = await nativeEvaluation(target, file, options.sources, ['--id', 'trial', '--model', 'fixture-local', ...format]);
    const result = (format.length ? JSON.parse(out) : decodeToon(out)) as { status: string; reason: string; rows?: unknown };
    assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'foreign_record_preserved'); assert.equal(result.rows, undefined);
  }
});

/** Failed child requests remain visible even when the parent later finishes correctly. */
test('evaluation records child reach and unknown usage after a child transport failure', async t => {
  const { suite, options } = await fixture(t);
  let roots = 0;
  const model = new ScriptedModel(request => {
    if (request.response_kind === 'answer') return '{"answer":"1"}';
    const prompt = JSON.parse(request.prompt.split('\n').at(-1)!) as { depth: number; transcript: unknown[] };
    if (prompt.depth > 0) throw new RlmError('model', 'Child transport failed');
    if (roots === 0 && prompt.transcript.length === 0) return '{"action":"partition","filter":{},"maxTokens":1000}';
    if (roots === 0 && prompt.transcript.length === 1) return '{"action":"spawn","subgoal":"Inspect the slice","slice":{"partition_step":0,"index":0}}';
    roots++; return '{"action":"finish","answer":"1"}';
  });
  const result = await evaluateRlm(suite, { ...options, stub: model });
  assert.equal(result.rows![0].recursive.children, 1);
  assert.equal(result.summary.recursive.children, 1);
  assert.equal(result.summary.recursive.failed_requests, 1);
  assert.equal(result.summary.recursive.tokens, null);
  assert.equal(result.summary.recursive.calls, 23);
  assert.equal(result.summary.recursive.correct, 20);
});

/** Native renderers and reused legacy receipts preserve missing child evidence and mixed totals. */
test('evaluation interrupted children stay unknown in native JSON TOON and reused aggregates', async t => {
  const { target, suite, options } = await fixture(t);
  await installExtension(target.workspace);
  const { endpoint } = await httpFixture(t, (request, response) => {
    response.end(JSON.stringify(request.url === '/api/tags' ? { models: [{ name: 'fixture-local' }] } : { response: '{"answer":"1","action":"finish"}', prompt_eval_count: 10, eval_count: 5 }));
  });
  const local = { ...options, mode: undefined, stub: undefined, model: 'fixture-local', endpoint };
  await assert.rejects(evaluateRlm(suite, { ...local, on_boundary: step => { if (step === 'baseline_reserved') throw new Error('interrupted'); } }), { code: 'incomplete' });
  await assert.rejects(evaluateRlm(suite, { ...local, on_boundary: step => { if (step === 'row_settled') throw new Error('paused after unknown row'); } }), { code: 'incomplete' });
  const receipt = (await target.client.get('rlm-eval-trial')).item;
  const state = JSON.parse(String(receipt.description)) as { complete: boolean; rows: NonNullable<RlmEvalResult['rows']> };
  assert.equal(state.rows[0].recursive.children, null);
  assert.equal(state.rows[0].truncated.children, null);
  // Supply known observations beside the real interrupted row without further inference.
  while (state.rows.length < suite.questions.length) {
    const row = structuredClone(state.rows[0]); row.id = suite.questions[state.rows.length].id;
    for (const arm of [row.truncated, row.recursive]) Object.assign(arm, { correct: true, refusal: '', children: 0, calls: 1, tokens_in: 10, tokens_out: 5, wall_ms: 1, failed_requests: 0 });
    state.rows.push(row);
  }
  state.complete = true;
  await target.client.update(receipt.id, { description: JSON.stringify(state) });
  const file = join(target.root, 'suite.json'); await writeFile(file, JSON.stringify(suite));
  for (const format of [['--json'], []]) {
    const out = await nativeEvaluation(target, file, options.sources, ['--id', 'trial', '--model', 'fixture-local', '--endpoint', endpoint, '--full', ...format]);
    const result = (format.length ? JSON.parse(out) : decodeToon(out)) as RlmEvalResult;
    for (const arm of ['truncated', 'recursive'] as const) {
      assert.equal(result.rows![0][arm].children, 'unknown');
      for (const counter of ['children', 'calls', 'tokens', 'wall_ms', 'failed_requests'] as const) assert.equal(result.summary[arm][counter], 'unknown');
      assert.equal(result.summary[arm].unknown_children_arms, 1);
      assert.equal(result.summary[arm].correct, 19);
    }
  }
  state.rows[0].recursive.children = 0; // Legacy interrupted metric must also become unknown.
  state.rows[1].recursive.children = 2;
  state.rows[2].recursive.refusal = 'interrupted'; state.rows[2].recursive.children = 0;
  await target.client.update(receipt.id, { description: JSON.stringify(state) });
  const reused = await evaluateRlm(suite, local);
  assert.equal(reused.rows![0].recursive.children, null);
  assert.equal(reused.rows![1].recursive.children, 2);
  assert.equal(reused.summary.recursive.children, null);
  assert.equal(reused.summary.recursive.unknown_children_arms, 2);
});
