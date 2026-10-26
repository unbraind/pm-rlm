import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testEnvironment } from '../scripts/environment.ts';
import { assertChildCompleted, assertRegression, proveRevert, testTimeout } from './revert-source.ts';

/** Standalone execution reaches the skip before Git, credentials, builds or output writes. */
test('public parity skips clearly in a standalone checkout without fleet fixtures', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'rlm-standalone-'));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  const root = join(scratch, 'worktrees', 'checkout');
  const source = join(import.meta.dirname, '..');
  for (const name of ['src', 'scripts', 'test', 'package.json']) await cp(join(source, name), join(root, name), { recursive: true });
  await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'junction');
  const result = spawnSync(process.execPath, ['test/sdk-boundaries-public.ts'], { cwd: root, encoding: 'utf8', env: { ...testEnvironment(process.env), PATH: scratch }, timeout: testTimeout(120000) });
  assertChildCompleted(result, testTimeout(120000));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SKIP SDK public parity: missing fleet checkouts \(pm-rlm, pm-lint\)/);
  assert.match(result.stdout, /README.md.*no parity evidence generated/);
  await assert.rejects(readFile(join(root, 'docs/sdk-adoption-validation.json')), { code: 'ENOENT' });
});

/** One knob scales default and explicit limits without retries or false regression evidence. */
test('regression deadlines scale and timeouts remain distinct from assertion proofs', async t => {
  const previous = process.env.PM_RLM_TEST_TIMEOUT_SCALE;
  t.after(() => {
    if (previous === undefined) delete process.env.PM_RLM_TEST_TIMEOUT_SCALE;
    else process.env.PM_RLM_TEST_TIMEOUT_SCALE = previous;
  });
  delete process.env.PM_RLM_TEST_TIMEOUT_SCALE;
  assert.equal(testTimeout(120000), 120000);
  process.env.PM_RLM_TEST_TIMEOUT_SCALE = '2.5';
  assert.equal(testTimeout(120000), 300000);
  assert.equal(testTimeout(300000), 750000);
  assert.equal(testTimeout(1), 3);
  for (const invalid of ['', '0', '-1', 'NaN', 'Infinity', '1e100']) {
    process.env.PM_RLM_TEST_TIMEOUT_SCALE = invalid;
    assert.throws(() => testTimeout(120000), /positive finite|positive safe integer/);
  }
  process.env.PM_RLM_TEST_TIMEOUT_SCALE = '2';
  const scratch = await mkdtemp(join(tmpdir(), 'rlm-deadline-'));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  const testFile = join(scratch, 'worker.test.ts');
  const file = join(scratch, 'source.ts');
  await writeFile(file, 'fixed');
  await writeFile(testFile, "import { test } from 'node:test';\ntest('slow', async () => { await new Promise(resolve => setTimeout(resolve, 60000)); });\n");
  assert.throws(() => proveRevert({ name: 'timeout restoration', file, before: 'fixed', after: 'previous', pattern: 'slow' }, testFile, 20), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'Error');
    assert.match(error.message, /timed out after 40 ms; no assertion proof observed/);
    return true;
  });
  assert.equal(await readFile(file, 'utf8'), 'fixed');
  await writeFile(testFile, "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('regression', () => assert.fail('genuine regression'));\n");
  assertRegression(testFile, 'regression', 120000, /genuine regression/);
  await writeFile(testFile, "import { test } from 'node:test';\ntest('passing', () => {});\n");
  assert.throws(() => assertRegression(testFile, 'passing'), { code: 'ERR_ASSERTION' });
  await writeFile(testFile, "import { test } from 'node:test';\ntest('unrelated', () => { throw new Error('not an assertion'); });\n");
  assert.throws(() => assertRegression(testFile, 'unrelated'), { code: 'ERR_ASSERTION' });
});
