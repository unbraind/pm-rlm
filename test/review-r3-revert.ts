/** Independently remove each round-three correction and require its regression to fail. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const proofs = [
  { name: 'wire keyword removal', file: 'src/action-schema.ts', before: '  return wire;', after: '  return schema;', pattern: '^review round 3 wire' },
  { name: 'adapter wire schema selection', file: 'src/adapters.ts', before: 'schema: answer ? COMPATIBLE_ANSWER_WIRE_SCHEMA : COMPATIBLE_ACTION_WIRE_SCHEMA', after: 'schema: answer ? COMPATIBLE_ANSWER_SCHEMA : COMPATIBLE_ACTION_SCHEMA', pattern: '^review round 3 wire' },
  { name: 'refusal code and reason comparison', file: 'src/engine.ts', before: "    if (observation?.refused !== refusal.code || (!legacyCodeOnly && observation?.reason !== refusal.message)) throw new RlmError('replay', `Recorded parse refusal differs at step ${call.id}:${call.steps.indexOf(step)}`);", after: '', pattern: '^review round 3 parse' },
  { name: 'resume refusal verification', file: 'src/engine.ts', before: '      for (const call of this.state.calls) for (const step of call.steps) if (step.response !== undefined && step.observation !== undefined) recordedAction(this.state, call, step);\n', after: '', pattern: '^review round 3 parse' },
  { name: 'replay refusal verification', file: 'src/engine.ts', before: '      const action = recordedAction(state, call, step);', after: '      let action: RlmAction;\n      try { action = parseAction(step.response.text, state.parser_version ?? 1); } catch { continue; }', pattern: '^review round 3 parse' },
];
for (const proof of proofs) {
  const original = readFileSync(proof.file, 'utf8');
  assert.ok(original.includes(proof.before), proof.name);
  try {
    let reverted = original.replace(proof.before, proof.after);
    if (proof.name === 'adapter wire schema selection') reverted = reverted.replace('COMPATIBLE_ACTION_WIRE_SCHEMA, COMPATIBLE_ANSWER_WIRE_SCHEMA, compatibleAction', 'COMPATIBLE_ACTION_SCHEMA, COMPATIBLE_ANSWER_SCHEMA, compatibleAction');
    writeFileSync(proof.file, reverted);
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', proof.pattern, 'test/review-r3.test.ts'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/);
    console.log(`${proof.name}: targeted regression fails with exit 1`);
  } finally {
    writeFileSync(proof.file, original);
    assert.equal(readFileSync(proof.file, 'utf8'), original);
  }
}
console.log(`${proofs.length}/${proofs.length} round-three revert proofs; source restored byte-for-byte`);
