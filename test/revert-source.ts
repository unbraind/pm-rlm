import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { testEnvironment } from '../scripts/environment.ts';

/** Replace an exact fixed snippet in current source, refusing missing or ambiguous matches. */
export function replaceFixed(source: string, fixed: string, previous: string, name: string, occurrences = 1): string {
  assert.notEqual(fixed, '', `${name}: fixed snippet must be nonempty`);
  assert.equal(source.split(fixed).length - 1, occurrences, `${name}: expected ${occurrences} exact fixed snippet match(es)`);
  return source.replaceAll(fixed, () => previous);
}

/** Scale each existing test deadline once; reject invalid configuration before spawning. */
export function testTimeout(milliseconds: number): number {
  const scale = Number(process.env.PM_RLM_TEST_TIMEOUT_SCALE ?? '1');
  assert.ok(Number.isFinite(scale) && scale > 0, 'PM_RLM_TEST_TIMEOUT_SCALE must be a positive finite number');
  const timeout = Math.ceil(milliseconds * scale);
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0, 'Scaled test timeout must be a positive safe integer');
  return timeout;
}

/** Keep missing time-limit evidence distinct from an observed regression assertion. */
export function assertChildCompleted(result: { error?: Error & { code?: string } }, timeout: number): void {
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`Regression child timed out after ${timeout} ms; no assertion proof observed. Increase PM_RLM_TEST_TIMEOUT_SCALE for a loaded host.`, { cause: result.error });
  }
  assert.equal(result.error, undefined);
}

/** Demand a real targeted assertion failure even when invoked inside Node's test runner. */
export function assertRegression(testFile: string, pattern: string, timeout = 120000, failure = /AssertionError|ERR_ASSERTION/): void {
  const limit = testTimeout(timeout);
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, testFile], { env: testEnvironment(process.env), encoding: 'utf8', timeout: limit });
  assertChildCompleted(result, limit);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, failure, result.stdout + result.stderr);
}

/** Verify one source-only correction and always restore its exact current bytes. */
export function proveRevert(proof: { name: string; file: string; before: string; after: string; pattern: string }, testFile: string, timeout = 120000): void {
  const original = readFileSync(proof.file, 'utf8');
  try {
    writeFileSync(proof.file, replaceFixed(original, proof.before, proof.after, proof.name));
    assertRegression(testFile, proof.pattern, timeout);
    console.log(`${proof.name}: targeted regression fails with exit 1 (assertion failure)`);
  } finally {
    writeFileSync(proof.file, original);
    assert.equal(readFileSync(proof.file, 'utf8'), original);
  }
}
