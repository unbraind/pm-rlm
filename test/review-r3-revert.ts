/** Independently remove each round-three correction and require its regression to fail. */
import { assertRegression, replaceFixed } from './revert-source.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const proofs = [
  { name: 'wire keyword removal', file: 'src/action-schema.ts', before: '  return wire;', after: '  return schema;', pattern: '^review round 3 wire' },
  { name: 'adapter wire schema selection', file: 'src/adapters.ts', before: 'schema: answer ? COMPATIBLE_ANSWER_WIRE_SCHEMA : COMPATIBLE_ACTION_WIRE_SCHEMA', after: 'schema: answer ? COMPATIBLE_ANSWER_SCHEMA : COMPATIBLE_ACTION_SCHEMA', pattern: '^review round 3 wire' },
  { name: 'refusal code and reason comparison', file: 'src/engine.ts', before: "    if (observation?.refused !== refusal.code || (!legacyCodeOnly && observation?.reason !== refusal.message) || observation!.remedy !== undefined) throw new RlmTranscriptError(`Recorded parse refusal differs at step ${call.id}:${call.steps.indexOf(step)}`);", after: '', pattern: '^review round 3 parse' },
  { name: 'resume refusal verification', file: 'src/engine.ts', before: '        const action = recordedAction(state, call, step, !observational && call.result === undefined && index === call.steps.length - 1);\n        if (action === undefined) continue;', after: '        let action: RlmAction;\n        try { action = parseAction(step.response!.text, state.parser_version ?? 1); } catch { continue; }', pattern: '^review round 3 parse' },
  { name: 'replay refusal verification', file: 'src/engine.ts', before: '      const action = recordedAction(state, call, step);', after: '      let action: RlmAction;\n      try { action = parseAction(step.response.text, state.parser_version ?? 1); } catch { continue; }', pattern: '^review round 3 parse' },
];
for (const proof of proofs) {
  const original = readFileSync(proof.file, 'utf8');
  try {
    let reverted = replaceFixed(original, proof.before, proof.after, proof.name);
    if (proof.name === 'adapter wire schema selection') reverted = replaceFixed(reverted, 'COMPATIBLE_ACTION_WIRE_SCHEMA, COMPATIBLE_ANSWER_WIRE_SCHEMA, compatibleAction', 'COMPATIBLE_ACTION_SCHEMA, COMPATIBLE_ANSWER_SCHEMA, compatibleAction', 'adapter schema imports');
    if (proof.name === 'replay refusal verification') reverted = replaceFixed(reverted, '  await new RlmEngine(ledger, state, new HttpModel(state.settings)).validateRecorded(false, true);', '', 'shared replay refusal verification');
    writeFileSync(proof.file, reverted);
    assertRegression('test/review-r3.test.ts', proof.pattern);
    console.log(`${proof.name}: targeted regression fails with exit 1`);
  } finally {
    writeFileSync(proof.file, original);
    assert.equal(readFileSync(proof.file, 'utf8'), original);
  }
}
console.log(`${proofs.length}/${proofs.length} round-three revert proofs; source restored byte-for-byte`);
