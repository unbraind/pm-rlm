/** Behavioral revert proof runs only in a disposable source copy and restores before cleanup. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testEnvironment } from '../scripts/environment.ts';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'repair-proof-'));
try {
  for (const name of ['src', 'test', 'scripts', 'index.ts', 'package.json', 'manifest.json']) await cp(join(root, name), join(scratch, name), { recursive: true });
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'junction');
  const env = testEnvironment(process.env);
  for (const key of Object.keys(env)) if (/^NODE_V8_COVERAGE$/i.test(key)) delete env[key];
  const proofs = [
    { file: 'src/repair.ts', pattern: 'zero budget retains', test: 'test/repair.test.ts', changes: [["} else if (target.kind === 'reuse') {", '} else if (false) {']] },
    { file: 'src/ledger.ts', pattern: 'native checkpoint history refuses ABA', test: 'test/repair-refusals.test.ts', changes: [['if (checkVersion && (await readHistoryEntries', 'if (false && (await readHistoryEntries'], [' || current !== version', '']] },
    { file: 'src/repair.ts', pattern: 'controller history rejects ABA', test: 'test/repair-refusals.test.ts', changes: [[' || current.length !== expected.length || current.digest !== expected.digest', '']] },
    { file: 'src/repair.ts', pattern: 'late native child completion', test: 'test/repair-refusals.test.ts', changes: [['after.reserved_tokens - accountedTokens', 'after.reserved_tokens - (existing === undefined ? 0 : before.reserved_tokens)']] },
    { file: 'src/engine.ts', pattern: 'native repair charges', test: 'test/repair-refusals.test.ts', changes: [['if (strictUsage && step.settled === true', 'if (false && step.settled === true'], ['if (strictUsage && state.reserved_tokens', 'if (false && state.reserved_tokens']] },
    { file: 'src/evidence.ts', pattern: 'repair schema fuzz', test: 'test/repair-refusals.test.ts', changes: [['Array.from(value).every', 'value.every']] },
  ];
  const selected = process.argv[2] === undefined ? proofs : proofs.filter(proof => proof.pattern.includes(process.argv[2]));
  assert.ok(selected.length > 0);
  for (const proof of selected) {
    const path = join(scratch, proof.file);
    const fixed = await readFile(path, 'utf8');
    let reverted = fixed;
    for (const [before, after] of proof.changes) { assert.equal(reverted.split(before).length, 2); reverted = reverted.replace(before, after); }
    /** Execute the same named regression against fixed, reverted, and restored function behavior. */
    const run = () => spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-name-pattern=' + proof.pattern, proof.test], { cwd: scratch, env, encoding: 'utf8', timeout: 300000 });
    const baseline = run(); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    try {
      await writeFile(path, reverted);
      const broken = run(); assert.equal(broken.status, 1, broken.stdout + broken.stderr);
      assert.match(broken.stdout + broken.stderr, /AssertionError/);
    } finally { await writeFile(path, fixed); }
    const restored = run(); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  }
  console.log(`${selected.length}/${selected.length} repair behavioral revert proofs: fixed pass, reverted behavior fails, restored pass`);
} finally { await rm(scratch, { recursive: true, force: true }); }
