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

/** Demand a real targeted assertion failure even when invoked inside Node's test runner. */
export function assertRegression(testFile: string, pattern: string, timeout = 120000, failure = /AssertionError|ERR_ASSERTION/): void {
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, testFile], { env: testEnvironment(process.env), encoding: 'utf8', timeout });
  assert.equal(result.error, undefined);
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
