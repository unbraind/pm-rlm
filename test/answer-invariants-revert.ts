/** Behavioral mutations run in a disposable non-git copy and never touch reviewed source. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testEnvironment } from '../scripts/environment.ts';

const repository = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'rlm-invariants-revert-'));
try {
  for (const path of ['src', 'scripts', 'test', 'index.ts', 'package.json']) await cp(join(repository, path), join(scratch, path), { recursive: true });
  await symlink(join(repository, 'node_modules'), join(scratch, 'node_modules'), 'junction');
  const proofs = [
    { file: 'src/answer-invariants.ts', before: 'const passed = actual === check.expected;', after: 'const passed = true;', pattern: 'cited false counts' },
    { file: 'src/answer-invariants.ts', before: 'items = corpus.items.filter(item => matches(item, contract.scope));', after: 'items = corpus.items;', pattern: 'scope intersection' },
    { file: 'src/environment.ts', before: 'const result = certifyCompleteListResult(input);', after: 'const result = input as ReturnType<typeof certifyCompleteListResult>;', pattern: 'empty complete scope' },
  ];
  for (const proof of proofs) {
    const file = join(scratch, proof.file);
    const fixed = await readFile(file, 'utf8');
    assert.equal(fixed.split(proof.before).length, 2);
    /** Run a single assertion-bearing regression with bounded process lifetime. */
    const run = () => spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-name-pattern=' + proof.pattern, 'test/answer-invariants.test.ts'], { cwd: scratch, env: testEnvironment(process.env), encoding: 'utf8', timeout: 180000 });
    const baseline = run(); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    try {
      await writeFile(file, fixed.replace(proof.before, proof.after));
      const broken = run(); assert.equal(broken.error, undefined); assert.equal(broken.status, 1, broken.stdout + broken.stderr);
      assert.match(broken.stdout + broken.stderr, /AssertionError/);
    } finally { await writeFile(file, fixed); }
    const restored = run(); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    console.log(proof.pattern + ': fixed passes, behavioral revert fails by assertion, restored passes');
  }
  console.log('3/3 executable answer invariant revert proofs passed');
} finally { await rm(scratch, { recursive: true, force: true }); }
