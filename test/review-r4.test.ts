import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHistoryPath } from '@unbrained/pm-cli/sdk';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { aggregateItems } from '../src/aggregates.ts';
import { readCorpus, createRlmContext } from '../src/environment.ts';
import { runRlm, replayRlm, resumeRlm } from '../src/engine.ts';
import { RlmLedger } from '../src/ledger.ts';
import type { RlmItem, RlmScalar } from '../src/types.ts';
import { publicSource } from './live.ts';
import { gitEnvironment, testEnvironment } from '../scripts/environment.ts';
import { ScriptedModel, tracker } from './helpers.ts';

/** Mixed types, numeric magnitude, duplicate counts and string escapes have one explicit order. */
test('review r4 scalar ordering is type then value for distinct and grouped counts', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Scalar fixture' });
  const template = (await readCorpus(workspace)).items[0];
  const expected: RlmScalar[] = [null, false, true, -10, -2, 0, 0.5, 2, 10, '"', '10', '2', '\\', 'a', 'é', '😀', '\ue000'];
  const values = [...expected, null, 10];
  for (const input of [values, [...values].reverse(), [...values.slice(5), ...values.slice(0, 5)]]) {
    const items: RlmItem[] = input.map(value => ({ ...template, extra: value }));
    assert.deepEqual(aggregateItems(items, { action: 'distinct', filter: {}, field: 'extra' }), expected);
    assert.deepEqual(aggregateItems(items, { action: 'group_count', filter: {}, field: 'extra' }), expected.map(value => ({ value, count: value === null || value === 10 ? 2 : 1 })));
    const legacy = [...new Set(values.map(value => JSON.stringify(value)))].sort().map(value => JSON.parse(value) as RlmScalar);
    assert.deepEqual(aggregateItems(items, { action: 'distinct', filter: {}, field: 'extra' }, 1), legacy);
  }
  await client.create({ title: 'Ten', estimatedMinutes: '10' });
  await client.create({ title: 'Two', estimatedMinutes: '2' });
  const context = await createRlmContext({ workspace, scope: { ids: (await readCorpus(workspace)).items.filter(item => item.title !== 'Scalar fixture').map(item => item.id) }, budget: 1000 });
  assert.deepEqual(context.aggregate({ action: 'distinct', filter: {}, field: 'estimated_minutes' }).data, [2, 10]);
});

/** Checkpoint semantics cover new runs, old receipts, resumed inference and invalid versions. */
test('review r4 checkpoint ordering preserves legacy replay and resume', async t => {
  const { workspace, client } = await tracker(t);
  await client.create({ title: 'Ten', estimatedMinutes: '10' });
  await client.create({ title: 'Two', estimatedMinutes: '2' });
  const actions = ['distinct', 'group_count'] as const;
  const model = new ScriptedModel((_request, index) => index < 2 ? JSON.stringify({ action: actions[index], field: 'estimated_minutes' }) : '{"action":"finish","answer":"done"}');
  const result = await runRlm('Ordered aggregates', { workspace, model });
  const ledger = new RlmLedger(workspace);
  const state = await ledger.load(result.run);
  assert.equal(state.aggregate_version, 2);
  assert.deepEqual(state.calls[0].steps.slice(0, 2).map(step => (step.observation as { data: unknown }).data), [[2, 10], [{ value: 2, count: 1 }, { value: 10, count: 1 }]]);
  /** Replay is observational for both modern and legacy checkpoints. */
  async function verifyReplay(): Promise<void> {
    const before = JSON.stringify((await client.listAllComplete({ includeBody: true })).items);
    const history = await readFile(getHistoryPath(workspace, result.run));
    await assert.doesNotReject(async () => { assert.deepEqual(await replayRlm(workspace, result.run), result); });
    assert.deepEqual(await readFile(getHistoryPath(workspace, result.run)), history);
    assert.equal(JSON.stringify((await client.listAllComplete({ includeBody: true })).items), before);
  }
  await verifyReplay();
  for (const version of [undefined, 1] as const) {
    const legacy = structuredClone(state);
    if (version === undefined) delete legacy.aggregate_version; else legacy.aggregate_version = version;
    for (const step of legacy.calls[0].steps.slice(0, 2)) (step.observation as { data: unknown[] }).data.reverse();
    await ledger.save(legacy);
    await verifyReplay();
    delete legacy.calls[0].result;
    legacy.calls[0].steps.pop();
    await ledger.save(legacy);
    const continuation = new ScriptedModel((_request, index) => index < 2 ? JSON.stringify({ action: actions[index], field: 'estimated_minutes' }) : '{"action":"finish","answer":"done"}');
    await resumeRlm(workspace, result.run, continuation);
    const resumed = await ledger.load(result.run);
    assert.equal(resumed.aggregate_version, version);
    assert.deepEqual(resumed.calls[0].steps.slice(2, 4).map(step => (step.observation as { data: unknown }).data), [[10, 2], [{ value: 10, count: 1 }, { value: 2, count: 1 }]]);
    assert.equal((await replayRlm(workspace, result.run)).answer, 'done');
  }
  for (const version of [0, 3, '2', null]) {
    await client.run('update', { id: result.run, options: { rlmState: JSON.stringify({ ...state, aggregate_version: version }) } });
    await assert.rejects(ledger.load(result.run), { code: 'incomplete' });
  }
});

/** Execute the actual URL-test callback with Node's Windows URL and path conversions. */
test('review r4 portable URL assertions pass under Windows path semantics', async () => {
  const source = await readFile(new URL('./constrained.test.ts', import.meta.url), 'utf8');
  const callback = source.match(/test\('live source URL converts escaped checkout paths to filesystem paths', \(\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(callback);
  const windowsBase = 'file:///C:/workspace/worktrees/pm-rlm-v2/test/live.ts';
  const implementation = publicSource.toString().replace('import.meta.url', JSON.stringify(windowsBase));
  assert.doesNotThrow(() => runInNewContext(`const publicSource = ${implementation};\n${callback}`, {
    assert, URL, join: win32.join, sep: win32.sep,
    resolve: (...paths: string[]) => win32.resolve('C:\\', ...paths),
    pathToFileURL: (path: string) => pathToFileURL(path, { windows: true }),
    fileURLToPath: (url: URL) => fileURLToPath(url, { windows: true }),
  }));
});

/** Real Git history distinguishes no matching commits from a mismatching source digest. */
test('review r4 report diagnoses empty history before trying blank revisions', async t => {
  const { root } = await tracker(t);
  const env = gitEnvironment(testEnvironment(process.env));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q');
  await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
  git('add', 'source.ts');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic source');
  const measurement = { rows: Array.from({ length: 24 }, () => ({})), model: 'glm-5.3:cloud', context_tokens: 131072, live_invocations: 1, paths: ['missing.ts'], implementation_source_sha256: 'mismatch' };
  const report = fileURLToPath(new URL('./report-v2.ts', import.meta.url));
  await writeFile(join(root, 'eval-results-v2.local.json'), JSON.stringify(measurement));
  const missing = spawnSync(process.execPath, [report], { cwd: root, env, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No Git history matches the measured source paths/);
  measurement.paths = ['source.ts'];
  await writeFile(join(root, 'eval-results-v2.local.json'), JSON.stringify(measurement));
  const mismatch = spawnSync(process.execPath, [report], { cwd: root, env, encoding: 'utf8' });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /A committed revision must reproduce every measured source byte/);
  measurement.implementation_source_sha256 = createHash('sha256').update('source.ts').update('\0').update(await readFile(join(root, 'source.ts'))).digest('hex');
  await writeFile(join(root, 'eval-results-v2.local.json'), JSON.stringify(measurement));
  // Reaching the next input proves a real nonempty candidate was retained and verified.
  const matched = spawnSync(process.execPath, [report], { cwd: root, env, encoding: 'utf8' });
  assert.equal(matched.status, 1);
  assert.match(matched.stderr, /ENOENT.*eval-results\.json/);
});
