/** Revert one behavior at a time, demand its assertion failure, and restore exact source bytes. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const portableFile = 'test/constrained.test.ts';
const callback = /test\('live source URL converts escaped checkout paths to filesystem paths', \(\) => \{[\s\S]*?\n\}\);/;
const oldPortable = execFileSync('git', ['show', `21a7ab0:${portableFile}`], { encoding: 'utf8' }).match(callback)?.[0];
assert.ok(oldPortable);
const currentPortable = readFileSync(portableFile, 'utf8').match(callback)?.[0];
assert.ok(currentPortable);
const proofs = [
  { name: 'numeric type/value ordering', file: 'src/aggregates.ts', before: '[...groups.values()].sort((a, b) => compareScalars(a.value, b.value))', after: '[...groups.keys()].sort().map(key => groups.get(key)!)', pattern: '^review r4 scalar' },
  { name: 'new checkpoint version', file: 'src/engine.ts', before: 'aggregate_version: 2, ', after: '', pattern: '^review r4 checkpoint' },
  { name: 'legacy replay version selection', file: 'src/engine.ts', before: 'state.settings.budget_tokens, state.aggregate_version ?? 1)', after: 'state.settings.budget_tokens, 2)', pattern: '^review r4 checkpoint' },
  { name: 'legacy resume version selection', file: 'src/engine.ts', before: 'state.settings.budget_tokens - state.reserved_tokens, state.aggregate_version ?? 1)', after: 'state.settings.budget_tokens - state.reserved_tokens, 2)', pattern: '^review r4 checkpoint' },
  { name: 'unknown checkpoint version refusal', file: 'src/ledger.ts', before: "      if (decoded.aggregate_version !== undefined && ![1, 2].includes(decoded.aggregate_version as number)) throw new Error('Invalid aggregate version');\n", after: '', pattern: '^review r4 checkpoint' },
  { name: 'portable assertions', file: portableFile, before: currentPortable, after: oldPortable, pattern: '^review r4 portable' },
  { name: 'empty history filtering', file: 'test/report-v2.ts', before: ".split('\\n').filter(line => line !== '')", after: ".trim().split('\\n')", pattern: '^review r4 report' },
];
for (const proof of proofs) {
  const original = readFileSync(proof.file, 'utf8');
  assert.equal(original.split(proof.before).length, 2, proof.name);
  try {
    writeFileSync(proof.file, original.replace(proof.before, proof.after));
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', proof.pattern, 'test/review-r4.test.ts'], { encoding: 'utf8', timeout: 180000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/, result.stdout + result.stderr);
    console.log(`${proof.name}: targeted regression fails with exit 1 (assertion failure)`);
  } finally {
    writeFileSync(proof.file, original);
    assert.equal(readFileSync(proof.file, 'utf8'), original);
  }
}
console.log(`${proofs.length}/${proofs.length} round-four behavioral revert proofs; source restored byte-for-byte`);
