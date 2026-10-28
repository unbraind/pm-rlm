import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gitEnvironment, testEnvironment } from '../scripts/environment.ts';
import { assertChildCompleted, replaceFixed, testTimeout } from './revert-source.ts';

/** Exact replacements reject source drift and preserve literal replacement characters. */
test('revert transforms refuse missing and ambiguous fixed snippets', () => {
  assert.equal(replaceFixed('fixed', 'fixed', '$& previous', 'literal'), '$& previous');
  assert.equal(replaceFixed('fixed fixed', 'fixed', 'old', 'multiple', 2), 'old old');
  assert.throws(() => replaceFixed('source', '', 'old', 'empty'), /empty: fixed snippet must be nonempty/);
  assert.throws(() => replaceFixed('source', 'fixed', 'old', 'missing'), /missing: expected 1 exact fixed snippet/);
  assert.throws(() => replaceFixed('fixed fixed', 'fixed', 'old', 'ambiguous'), /ambiguous: expected 1 exact fixed snippet/);
});

/** Run every committed proof against HEAD with only one Git commit available. */
test('every revert script succeeds in a depth-one clone of HEAD', { timeout: testTimeout(3600000) }, async t => {
  const source = join(import.meta.dirname, '..');
  const scratch = await mkdtemp(join(tmpdir(), 'rlm-shallow-'));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  const clone = join(scratch, 'clone');
  const env = gitEnvironment(testEnvironment(process.env));
  // Nested mutation runs must not mix their coverage with the release report.
  for (const key of Object.keys(env)) if (/^NODE_V8_COVERAGE$/i.test(key)) delete env[key];
  /** Execute Git without inherited worktree overrides. */
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(source, 'clone', '--quiet', '--depth', '1', pathToFileURL(source).href, clone);
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  assert.equal(git(clone, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
  const scripts = (await readdir(join(source, 'test'))).filter(name => /(?:^|-)revert\.ts$/.test(name)).sort();
  assert.equal(scripts.length, 13);
  assert.ok(scripts.includes('sdk-boundaries-revert.ts'));
  assert.ok(scripts.includes('lock-retry-revert.ts'));
  for (const name of [...scripts, 'revert-source.ts']) {
    assert.deepEqual(await readFile(join(clone, 'test', name)), await readFile(join(source, 'test', name)), `${name}: commit proof changes before testing HEAD`);
  }
  // Reuse the locked dependencies; all mutated source and Git objects belong to the clone.
  await symlink(join(source, 'node_modules'), join(clone, 'node_modules'), 'junction');
  for (const name of scripts) {
    await t.test(name, () => {
      const result = spawnSync(process.execPath, [join('test', name)], { cwd: clone, env, encoding: 'utf8', timeout: testTimeout(1800000) });
      assertChildCompleted(result, testTimeout(1800000));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /\d+\/\d+ .*revert proofs/);
      assert.equal(git(clone, 'status', '--porcelain', '--untracked-files=no'), '', `${name}: restore tracked source bytes`);
      t.diagnostic(result.stdout.trim());
    });
  }
});
