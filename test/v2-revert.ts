/** Prove each new behavior fails independently when only its production branch is removed. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const proofs = [
  { name: 'same seeded question selection', file: 'test/eval-questions.ts', before: "EVAL_SEED + task.question + ' Answer only the integer or id.'", after: 'EVAL_SEED + task.question', pattern: '^seeded eval', test: 'test/round2.test.ts' },
  { name: 'fair stuffing envelope extraction', file: 'test/live.ts', before: 'JSON.parse(extractObject(output))', after: 'JSON.parse(output)', pattern: '^v2 parser' },
  { name: 'parser envelope extraction', file: 'src/protocol.ts', before: 'JSON.parse(extractObject(output))', after: 'JSON.parse(output)', pattern: '^v2 parser' },
  { name: 'corrective refusal feedback', file: 'src/engine.ts', before: ', reason: error.message', after: '', pattern: '^v2 ledger' },
  { name: 'count', file: 'src/aggregates.ts', before: "case 'count': return rows.length;", after: "case 'count': return 0;", pattern: '^v2 aggregates compute' },
  { name: 'sum', file: 'src/aggregates.ts', before: "case 'sum': return rows.reduce((sum, item) => finite(sum + numeric(item, action.field_expr)), 0);", after: "case 'sum': return 0;", pattern: '^v2 aggregates compute' },
  { name: 'distinct', file: 'src/aggregates.ts', before: "sorted.map(row => row.value) : sorted", after: '[] : sorted', pattern: '^v2 aggregates compute' },
  { name: 'group_count', file: 'src/aggregates.ts', before: 'sorted.map(row => row.value) : sorted', after: 'sorted.map(row => row.value) : []', pattern: '^v2 aggregates compute' },
  ...['argmax', 'argmin'].map(name => ({ name, file: 'src/aggregates.ts', before: 'return sorted.filter(row => row.value === sorted[0].value).map(row => row.id).sort();', after: `if (action.action === '${name}') return []; return sorted.filter(row => row.value === sorted[0].value).map(row => row.id).sort();`, pattern: '^v2 aggregates compute' })),
];
for (const proof of proofs) {
  const original = readFileSync(proof.file, 'utf8');
  assert.equal(original.split(proof.before).length, 2);
  try {
    writeFileSync(proof.file, original.replace(proof.before, proof.after));
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', proof.pattern, proof.test ?? 'test/v2.test.ts'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION|AssertionError/);
    console.log(`${proof.name}: regression fails (exit 1) with only its production behavior reverted`);
  } finally { writeFileSync(proof.file, original); assert.equal(readFileSync(proof.file, 'utf8'), original); }
}
console.log(`${proofs.length}/${proofs.length} behavioral revert proofs; source restored byte-for-byte`);
