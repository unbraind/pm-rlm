import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import type { CommandHandlerContext } from '@unbrained/pm-cli/sdk/authoring';
import { gitEnvironment, npmEnvironment, testEnvironment } from '../scripts/environment.ts';
import { runCommand } from '../src/commands.ts';
import { assertLedgerPrivacy } from '../src/errors.ts';
import { readCorpus } from '../src/environment.ts';
import { writeRlmSettings } from '../src/settings.ts';
import { tracker } from './helpers.ts';

/** Every Git subprocess uses the same Windows-safe environment boundary. */
test('Git environment filtering removes mixed-case selection and config keys', () => {
  const inherited = { Path: 'keep', HOME: 'keep-home', Git_DIR: 'other', git_work_tree: 'other', GiT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', git_config_value_0: 'true', GIT_NO_REPLACE_OBJECTS: '0', GITHUB_TOKEN: 'keep-token' };
  assert.deepEqual(gitEnvironment(inherited), { Path: 'keep', HOME: 'keep-home', GITHUB_TOKEN: 'keep-token' });
  assert.equal(inherited.Git_DIR, 'other', 'The parent environment is unchanged');
});

/** Audit and packed consumers remove duplicate Windows-style npm configuration keys. */
test('npm environment filtering isolates mixed-case script and user configuration', () => {
  const inherited = { Path: 'keep', npm_config_allow_scripts: 'old', NPM_CONFIG_ALLOW_SCRIPTS: 'old', Npm_Config_Allow_Scripts: 'old', NpM_CoNfIg_UsErCoNfIg: 'private', npm_config_userconfig: 'private', NPM_CONFIG_USERCONFIG: 'private', npm_config_registry: 'keep-registry', NPM_TOKEN: 'synthetic', NODE_AUTH_TOKEN: 'synthetic', NPM_MEDIA_SERVER: 'synthetic', EXAMPLE_API_KEY: 'synthetic' };
  assert.deepEqual(npmEnvironment(inherited), { Path: 'keep', npm_config_registry: 'keep-registry', npm_config_userconfig: devNull });
});

/** Recovery workers retain coverage while removing every spelling of test-runner context. */
test('test environment filtering removes mixed-case runner context only', () => {
  assert.deepEqual(testEnvironment({ NODE_TEST_CONTEXT: 'child', Node_Test_Context: 'child', node_test_context: 'child', NODE_V8_COVERAGE: 'keep', PATH: 'keep' }), { NODE_V8_COVERAGE: 'keep', PATH: 'keep' });
});

/** Invalid operands are refused before any question or call item is created. */
test('all CLI operands reject blanks and nondecimal or unsafe numeric inputs', async t => {
  const { workspace } = await tracker(t);
  const ctx = { command: 'rlm run', pm_root: workspace, args: ['q'], options: { budgetTokens: '1' }, global: { author: 'rlm-test' } } as CommandHandlerContext;
  for (const option of ['maxDepth', 'maxCalls', 'budgetTokens']) {
    for (const value of ['', ' ', '\t\n', '+1', '-0', '-1', 'NaN', 'Infinity', '1e3', '0x10', '1.5', ' 1 ', '9007199254740992', '9'.repeat(400)]) {
      await assert.rejects(runCommand('run', { ...ctx, options: { ...ctx.options, [option]: value } }), { exitCode: 2 }, `${option} must refuse the operand`);
    }
  }
  for (const option of ['model', 'scope']) for (const value of ['', ' ', '\t\n']) await assert.rejects(runCommand('run', { ...ctx, options: { ...ctx.options, [option]: value } }), { exitCode: 2 });
  for (const command of ['run', 'tree', 'resume', 'replay']) for (const value of ['', ' ', '\t\n']) await assert.rejects(runCommand(command, { ...ctx, args: [value] }), { exitCode: 2 });
  for (const [maxDepth, maxCalls, budgetTokens] of [['33', '1', '1'], ['0', '0', '1'], ['0', '1', '1000000001']]) await assert.rejects(runCommand('run', { ...ctx, options: { maxDepth, maxCalls, budgetTokens } }), { exitCode: 2 });
  assert.equal((await readCorpus(workspace)).items.length, 0);
  await assert.rejects(runCommand('run', { ...ctx, options: { maxDepth: '0', maxCalls: '1', budgetTokens: '1', model: 'model:tag', scope: ' \n{}\t' } }), { exitCode: 3 }, 'Zero depth and JSON whitespace remain valid');
});

/** Shallow workspaces must permit public URLs while still refusing their actual path. */
test('privacy skips filesystem-root ancestors and normalizes portable workspace paths', async t => {
  const key = 'RLM_ROUND4_UNUSED_KEY';
  for (const workspace of [sep + 'pm', sep + 'data' + sep + 'pm', sep + 'data' + sep + 'pm' + sep, 'C:\\pm', 'C:\\data\\pm\\', 'c:/data/pm/', '//server/share/pm/']) {
    assert.doesNotThrow(() => assertLedgerPrivacy({ endpoint: 'http://localhost:11434', answer: 'a/b' }, workspace, key));
    assert.throws(() => assertLedgerPrivacy({ echo: workspace }, workspace, key), { code: 'invalid' });
  }
  for (const echo of ['c:\\data\\scratch\\pm\\answer', 'C:/DATA/scratch/pm/answer', 'c:/data/other/file']) assert.throws(() => assertLedgerPrivacy({ echo }, 'C:\\data\\scratch\\pm\\', key), { code: 'invalid' });
  for (const echo of ['\\\\SERVER\\Share\\private\\scratch\\pm\\answer', '//server/share/private/other/file']) assert.throws(() => assertLedgerPrivacy({ echo }, '\\\\server\\share\\private\\scratch\\pm\\', key), { code: 'invalid' });
  assert.throws(() => assertLedgerPrivacy({ echo: 'c:/DATA/quoted-"-root/pm/result' }, 'C:\\data\\quoted-"-root\\pm', key), { code: 'invalid' });
  assert.doesNotThrow(() => assertLedgerPrivacy({ answer: 'C:/public/file' }, 'C:\\data\\scratch\\pm\\', key));
  assert.doesNotThrow(() => assertLedgerPrivacy({ answer: 'https://example.invalid' }, '\\\\server\\share\\pm', key));
  assert.throws(() => assertLedgerPrivacy({ echo: 'c:/private' }, 'C:\\', key), { code: 'invalid' });
  const { workspace } = await tracker(t);
  await writeRlmSettings(workspace, { model: 'synthetic' }, 'rlm-test');
});

/** The offline report can run repeatedly after editorial changes, without live inference. */
test('eval report replaces only a unique marked block and is idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rlm-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = 'synthetic frozen implementation';
  await writeFile(join(root, 'fixture.ts'), source);
  await writeFile(join(root, 'live-r3.started.local'), JSON.stringify({ paths: ['fixture.ts'], started_at_utc: '2026-10-18T00:00:00Z', implementation_source_sha256: createHash('sha256').update('fixture.ts').update('\0').update(source).digest('hex') }));
  const arm = { correct: false, tokens: 2, ms: 10, calls: 1, error: '' };
  const row = { repo: 'fixture', revision: 'a'.repeat(40), index: 0, question: 'Synthetic question', expected: 'synthetic', corpus_items: 1, corpus_bytes: 20, stuffing: arm, rlm: { ...arm, reached_child: false, model_calls: 1, reserved: 2, pending: 0, read_tokens: 0, refusals: {} } };
  await writeFile(join(root, 'eval-results.local.json'), JSON.stringify({ design: 'synthetic', model: 'glm-5.3:cloud', measured_at_utc: '2026-10-19T00:00:00Z', context_tokens: 131072, rows: Array.from({ length: 24 }, (_, index) => ({ ...row, index })) }));
  const before = '# Edited introduction\nThe following measurements are **historical but outside the block.\n';
  const after = '\n## Edited ending\nPreserve this.\n';
  const start = '<!-- eval-table:start -->'; const end = '<!-- eval-table:end -->';
  const initial = before + start + '\nstale table\n' + end + after;
  await writeFile(join(root, 'README.md'), initial);
  /** Execute only the saved-measurement formatter in the scratch directory. */
  const report = () => spawnSync(process.execPath, [join(import.meta.dirname, 'eval-report.ts')], { cwd: root, encoding: 'utf8' });
  assert.equal(report().status, 0);
  const updated = await readFile(join(root, 'README.md'), 'utf8');
  assert.ok(updated.startsWith(before)); assert.ok(updated.endsWith(after));
  assert.ok(!updated.includes('stale table'));
  assert.equal(report().status, 0, 'Rerun without the former heading');
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), updated);
  const results = await readFile(join(root, 'eval-results.json'), 'utf8');
  const cloud = await readFile(join(root, 'docs/EVAL-CLOUD.md'), 'utf8');
  for (const output of [updated, cloud]) {
    assert.ok(output.includes('| Reported-or-estimated model tokens / question |'));
    assert.match(output, /Invalidated by an instruction conflict/);
    assert.match(output, /bare integer or id while both arms required JSON/);
  }
  assert.equal((JSON.parse(results) as { validation: { status: string } }).validation.status, 'invalidated');
  assert.match((JSON.parse(results) as { measurement: string }).measurement, /reported-or-estimated/);
  const metadata = JSON.parse(results) as { metric_provenance: { model_tokens: string; timing: string; pending_tokens: string } };
  assert.match(metadata.metric_provenance.model_tokens, /Provider-reported.*estimates/);
  assert.match(metadata.metric_provenance.timing, /Measured/);
  assert.match(metadata.metric_provenance.pending_tokens, /estimates/);
  for (const malformed of [before + end, start + 'missing end', start + end + start, end + start + end, start + end + end]) {
    await writeFile(join(root, 'README.md'), malformed);
    const rejected = report(); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /markers/);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), malformed);
    assert.equal(await readFile(join(root, 'eval-results.json'), 'utf8'), results);
    assert.equal(await readFile(join(root, 'docs/EVAL-CLOUD.md'), 'utf8'), cloud);
  }
});
