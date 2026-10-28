/** Prove retry deadline regressions in disposable copies without editing the package worktree. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { testEnvironment } from '../scripts/environment.ts';

const repository = resolve(import.meta.dirname, '..');
const sandbox = mkdtempSync(join(tmpdir(), 'rlm-retry-revert-'));

/** Run one targeted behavioral check and require an assertion failure for a reverted implementation. */
function check(pattern: string, reverted: boolean): void {
  const child = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=spec', '--test-name-pattern', pattern, 'test/lock-retry-deadline.test.ts'], {
    cwd: sandbox, env: testEnvironment(process.env), encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, reverted ? 1 : 0, child.stdout + child.stderr);
  if (reverted) assert.match(child.stdout + child.stderr, /AssertionError|ERR_ASSERTION/);
}

/** Revert exactly one behavior in the disposable copy, then restore and rerun the passing regression. */
function prove(name: string, file: string, before: string, after: string, pattern: string): void {
  const path = join(sandbox, file);
  const fixed = readFileSync(path, 'utf8');
  assert.equal(fixed.split(before).length - 1, 1, name);
  try {
    writeFileSync(path, fixed.replace(before, after));
    check(pattern, true);
  } finally { writeFileSync(path, fixed); }
  check(pattern, false);
  console.log(`${name}: assertion fails on behavioral revert and passes after restoration`);
}

try {
  for (const file of ['src', 'test/helpers.ts', 'test/lock-retry-deadline.test.ts', 'scripts/environment.ts', 'package.json']) {
    mkdirSync(dirname(join(sandbox, file)), { recursive: true });
    cpSync(join(repository, file), join(sandbox, file), { recursive: true });
  }
  symlinkSync(join(repository, 'node_modules'), join(sandbox, 'node_modules'), 'dir');
  prove('pre-attempt deadline', 'src/lock-retry.ts', '    if (now() >= deadline) throw lastError;', '    void lastError;', '^dead-owner retry caps');
  prove('remaining-budget sleep cap', 'src/lock-retry.ts', 'await sleep(Math.min(delay, remainingMs));', 'await sleep(delay);', '^dead-owner retry caps');
  prove('hint and jitter caps', 'src/lock-retry.ts', 'return Math.min(ceiling, MAX_RETRY_DELAY_MS, Math.max(1, Math.round(grown * (0.5 + random()))));', 'return Math.max(1, Math.round(grown * (0.5 + random())));', '^dead-owner retries obey exact');
  const ledger = readFileSync(join(sandbox, 'src/ledger.ts'), 'utf8');
  const start = ledger.indexOf('    const unlock = await retryWithinBudget');
  const end = ledger.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start);
  prove('storage deadline adoption', 'src/ledger.ts', ledger.slice(start, end), `    const deadline = this.retryTiming.now!() + 60000;
    for (;;) {
      let unlock: () => Promise<void>;
      try { unlock = await this.lease('__blob_store'); }
      catch (error) {
        if (!(error instanceof RlmError) || error.code !== 'busy' || this.retryTiming.now!() >= deadline) throw error;
        await this.retryTiming.sleep!(25);
        continue;
      }
      try { return await operation(new RlmBlobs(this.workspace)); }
      finally { await unlock(); }
    }`, '^non-git storage retries');
  console.log('4/4 lock retry behavioral revert proofs passed');
} finally { rmSync(sandbox, { recursive: true, force: true }); }
