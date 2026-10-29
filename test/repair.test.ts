import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, symlink, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { decodeToon } from '@unbrained/pm-cli/sdk/testing';
import { compactRepairResult, repairRlm, resumeRepairRlm } from '../src/repair.ts';
import { parseRepairRequest, parseRepairCheckpoint, RlmRepairError, validateRepairResult } from '../src/repair-contract.ts';
import { RlmLedger } from '../src/ledger.ts';
import { prepareRlmRun } from '../src/engine.ts';
import { runCommand } from '../src/commands.ts';
import { RlmError } from '../src/errors.ts';
import { ScriptedModel, installExtension } from './helpers.ts';
import { repairFixture, repairModel, repairPrompt, repaired } from './repair-fixture.ts';
import type { RlmRepairCheckpoint } from '../src/repair-contract.ts';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';

/** One gap among ten must cause exactly one child, preserving all nine original answers. */
test('repair schedules only one of ten components and reuses nine supported answers', async t => {
  const { workspace, request, ids, client, source } = await repairFixture(t, 10);
  const before = (await client.get(source.run, { depth: 'full' })).item;
  const model = repairModel(ids[9]);
  const result = repaired(await repairRlm(request, { workspace, model }));
  assert.equal(result.status, 'complete'); assert.deepEqual(result.scheduled, ['part9']);
  assert.equal(result.reused, 9); assert.equal(result.calls, 1); assert.equal(model.requests.length, 2);
  assert.deepEqual(result.components.slice(0, 9).map(part => part.answer), source.components!.slice(0, 9).map(part => part.answer));
  assert.deepEqual((await client.get(source.run, { depth: 'full' })).item, before);
  const resumed = repaired(await resumeRepairRlm(result.run, { workspace, model }));
  assert.deepEqual(resumed, result); assert.equal(model.requests.length, 2);
  assert.equal(compactRepairResult(result).status, 'complete');
  t.diagnostic(`10 components: ${result.scheduled.length} scheduled, ${result.reused} reused, ${model.requests.length} model requests, ${result.budget.charged} charged`);
});

/** Exact zero admission retains all supported answers and names every unscheduled dependency. */
test('zero budget retains supported components with named gaps and transitive dependencies', async t => {
  const { workspace, request, ids } = await repairFixture(t);
  request.parts[0].depends_on = ['part2'];
  const model = repairModel(ids[2]);
  const result = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace, model }));
  assert.equal(result.status, 'partial'); assert.equal(result.reused, 1);
  assert.deepEqual(result.scheduled, ['part0', 'part2']); assert.deepEqual(result.gaps, ['part0', 'part2']);
  assert.deepEqual(result.components.map(part => part.component), request.parts.map(part => part.name));
  assert.equal(result.components[0].reason, 'dependency_gap'); assert.equal(result.components[2].reason, 'budget');
  assert.equal(model.requests.length, 0); assert.equal(result.budget.charged, 0);
  assert.deepEqual(repaired(await resumeRepairRlm(result.run, { workspace, model })), result);
});

/** A fresh budget continues a partial repair without repeating its newly completed component. */
test('fresh repair of a partial repair reuses completed native children and preserves their origins', async t => {
  const { workspace, request, ids } = await repairFixture(t);
  request.parts[0].depends_on = ['part2'];
  const child = repairModel(ids[2]);
  const interrupted = new ScriptedModel(async input => {
    if (JSON.parse(repairPrompt(input).question).part.name === 'part0') throw new RlmError('budget', 'Fixture allowance exhausted');
    return (await child.complete(input)).text;
  });
  const partial = repaired(await repairRlm({ ...request, budget_tokens: 20000 }, { workspace, model: interrupted }));
  assert.deepEqual(partial.gaps, ['part0']); assert.equal(partial.components[2].disposition, 'repaired');
  const model = repairModel(ids[0]);
  const complete = repaired(await repairRlm({ ...request, source: partial.run }, { workspace, model }));
  assert.equal(complete.status, 'complete'); assert.deepEqual(complete.scheduled, ['part0']); assert.equal(complete.reused, 2);
  assert.equal(model.requests.length, 2); assert.equal(complete.calls, 1);
  assert.equal(complete.components[2].run, partial.components[2].run);
  assert.deepEqual(repaired(await resumeRepairRlm(complete.run, { workspace, model })), complete);
  const changed = structuredClone(request.parts); changed[0].question = 'Different question';
  await assert.rejects(repairRlm({ source: partial.run, parts: changed, budget_tokens: 0 }, { workspace }), RlmRepairError);
});

/** Source revisions invalidate their dependents and never re-execute unrelated completed work. */
test('changed source repairs only its component and downstream dependencies', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  request.parts[0].depends_on = ['part2'];
  await client.update(ids[1], { description: 'changed' });
  const model = new ScriptedModel(request => {
    const input = repairPrompt(request);
    const part = JSON.parse(input.question).part.name as string;
    const id = ids[Number(part.slice(4))];
    return JSON.stringify(input.transcript.length === 0 ? { action: 'witness', id, start: 0, end: 20 } : { action: 'answer', components: [{ component: part, status: 'supported', answer: part, reason: '', witnesses: [{ step: 0, digest: input.transcript[0].observation.data.digest }] }] });
  });
  const result = repaired(await repairRlm(request, { workspace, model }));
  assert.deepEqual(result.scheduled, ['part0', 'part1', 'part2']); assert.equal(result.status, 'complete');
  assert.equal(model.requests.length, 6); assert.equal(result.reused, 0);
});

/** An interrupted child intent is durable; recovery revalidates its sources and skips dependents. */
test('repair recovery refuses stale intent and retains unaffected supported answers', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  request.parts[0].depends_on = ['part2'];
  let run = '';
  const model = repairModel(ids[2]);
  await assert.rejects(repairRlm(request, { workspace, model, on_transition: (name, id) => { run = id; if (name === 'intent:part2') throw new Error('crash'); } }), RlmRepairError);
  await client.update(ids[2], { description: 'different source' });
  const result = repaired(await resumeRepairRlm(run, { workspace, model }));
  assert.deepEqual(result.gaps, ['part0', 'part2']); assert.equal(result.reused, 1); assert.equal(model.requests.length, 0);
  assert.equal(result.components[2].reason, 'source_changed');
});

/** Crashes after native preparation reuse the same child and charge its accounting once. */
test('repair recovers prepared and completed child checkpoints without duplicate inference', async t => {
  const { workspace, request, ids } = await repairFixture(t);
  for (const stop of ['prepared:part2', 'saved:part2']) {
    let run = '';
    const model = repairModel(ids[2]);
    await assert.rejects(repairRlm(request, { workspace, model, on_transition: (name, id) => { run = id; if (name === stop) throw new Error('crash'); } }), RlmRepairError);
    if (stop === 'prepared:part2') await assert.rejects(repairRlm({ ...request, source: run }, { workspace, model }), RlmRepairError);
    const result = repaired(await resumeRepairRlm(run, { workspace, model }));
    assert.equal(result.status, 'complete'); assert.equal(model.requests.length, 2); assert.equal(result.calls, 1);
  }
});

/** Foreign data, missing dependencies and malformed boundary values fail before side effects. */
test('strict repair boundaries reject sparse extreme and incomplete declarations with remedies', async t => {
  const { workspace, request, ids, client } = await repairFixture(t);
  const count = (await client.listAllComplete()).items.length;
  const invalid: unknown[] = [null, [], {}, { ...request, extra: true }, { ...request, parts: [] }, { ...request, parts: new Array(3) }, { ...request, parts: [...request.parts, request.parts[0]] }];
  for (const budget_tokens of [NaN, Infinity, -Infinity, -1, 0.1, 1000000001, Number.MAX_SAFE_INTEGER, '2', null]) invalid.push({ ...request, budget_tokens });
  for (const mutate of [
    (value: typeof request) => { value.parts[0].depends_on = ['missing']; },
    (value: typeof request) => { value.parts[0].depends_on = ['part0']; },
    (value: typeof request) => { value.parts[0].sources = []; },
    (value: typeof request) => { value.parts[0].sources.push(value.parts[0].sources[0]); },
    (value: typeof request) => { value.parts[0].question = ' '; },
  ]) { const value = structuredClone(request); mutate(value); invalid.push(value); }
  for (const value of invalid) assert.throws(() => parseRepairRequest(value), RlmRepairError);
  assert.equal((await client.listAllComplete()).items.length, count);
  assert.equal((await repairRlm({ ...request, source: ids[0] }, { workspace })).status, 'skipped');
  assert.equal((await resumeRepairRlm(ids[0], { workspace })).status, 'skipped');
  await assert.rejects(repairRlm({ ...request, parts: request.parts.slice(1) }, { workspace }), RlmRepairError);
  const outOfScope = structuredClone(request); outOfScope.parts[0].sources = ['missing'];
  await assert.rejects(repairRlm(outOfScope, { workspace }), { code: 'scope' });
  const witnessMismatch = structuredClone(request); witnessMismatch.parts[0].sources = [ids[1]];
  await assert.rejects(repairRlm(witnessMismatch, { workspace }), { code: 'scope' });
  await assert.rejects(repairRlm(request, { workspace, model: Object.assign(repairModel(ids[2]), { name: 'wrong-model' }) }), RlmRepairError);
  assert.ok(new RlmRepairError().remedy.length > 0);
  const result = repaired(await repairRlm({ ...request, budget_tokens: 0 }, { workspace }));
  for (const value of [NaN, Infinity, -1, 0.5, 1000000001]) assert.throws(() => validateRepairResult({ ...result, budget: { ...result.budget, charged: value } }), RlmRepairError);
  assert.throws(() => validateRepairResult({ ...result, budget: { limit: 5, charged: 2, remaining: 2 } }), RlmRepairError);
  assert.equal(compactRepairResult({ status: 'skipped', reason: 'foreign', remedy: 'inspect' }).status, 'skipped');
  assert.throws(() => parseRepairCheckpoint({}), RlmRepairError);
  await assert.rejects(prepareRlmRun('q', { workspace }, undefined, 'bad/id'), { code: 'invalid' });
});

/** Native dispatch and both agent renderers function with no git binary or enclosing repository. */
test('repair CLI and SDK expose complete zero-budget receipts without git', async t => {
  const { root, workspace, request } = await repairFixture(t);
  await installExtension(workspace);
  await assert.rejects(access(join(root, '.git')), { code: 'ENOENT' });
  const bin = join(root, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  let run = '';
  const formats = ['--json', '--output-format=toon'];
  for (const format of formats) {
    const argv = [join(import.meta.dirname, '../node_modules/.bin/pm'), 'rlm', 'repair', request.source, '--parts', JSON.stringify(request.parts), '--budget-tokens', '0', format];
    const childEnv = { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root), PM_PATH: workspace };
    const cli = spawnSync(process.execPath, argv, { encoding: 'utf8', env: childEnv, cwd: root });
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    const result = (format === '--json' ? JSON.parse(cli.stdout) : decodeToon(cli.stdout)) as { run: string; gaps: string[]; reused: number };
    run = result.run; assert.deepEqual(result.gaps, ['part2']); assert.equal(result.reused, 2); assert.ok(Buffer.byteLength(cli.stdout) < 2200);
  }
  const context = { command: 'rlm repair', pm_root: workspace, args: [request.source], global: { author: 'rlm-test' }, options: { parts: JSON.stringify(request.parts), budgetTokens: '0', full: true } } as CommandHandlerContext;
  const result = await runCommand('repair', context); assert.ok(Array.isArray(result.components));
  assert.equal((await runCommand('repair-resume', { ...context, args: [run] })).status, 'partial');
  for (const options of [{ ...context.options, parts: '{' }, { ...context.options, budgetTokens: undefined }, { ...context.options, budgetTokens: 'Infinity' }]) await assert.rejects(runCommand('repair', { ...context, options }), { exitCode: 2 });
  const native = (await new RlmLedger(workspace).client.get(run, { depth: 'full' })).item;
  const checkpoint = JSON.parse(native.description!.slice('RLM repair v1\n'.length)) as RlmRepairCheckpoint;
  assert.deepEqual(parseRepairCheckpoint(checkpoint), checkpoint);
  assert.throws(() => parseRepairCheckpoint({ ...checkpoint, targets: [] }), RlmRepairError);
  await readFile(join(workspace, 'settings.json'));
});
