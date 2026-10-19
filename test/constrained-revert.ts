/** Verify each review correction and wire contract with its behavior independently removed. */
import { assertRegression, replaceFixed } from './revert-source.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const proofs = [
  { name: 'raw compatible duplicate-key check', file: 'src/action-schema.ts', before: '    extractObject(output);\n', after: '', pattern: '^constrained wrapped duplicate', test: 'test/constrained.test.ts' },
  { name: 'checkpoint parser selection', file: 'src/engine.ts', before: 'state.parser_version ?? 1', after: '3', occurrences: 6, pattern: '^parser versions', test: 'test/constrained.test.ts' },
  { name: 'strict legacy parser', file: 'src/protocol.ts', before: 'version === 1 ? output : extractObject(output)', after: 'extractObject(output)', pattern: '^parser versions', test: 'test/constrained.test.ts' },
  { name: 'URL-decoded source paths', file: 'test/live.ts', before: 'fileURLToPath(new URL(`../../../fleet/${repo}/`, base))', after: 'new URL(`../../../fleet/${repo}/`, base).pathname', pattern: '^live source URL', test: 'test/constrained.test.ts' },
  { name: 'Ollama action schema', file: 'src/adapters.ts', before: "format: legacy ? 'json' : schema", after: "format: 'json'", pattern: '^HTTP adapters', test: 'test/adapters.test.ts' },
  { name: 'OpenAI-compatible action schema', file: 'src/adapters.ts', before: 'schema: answer ? COMPATIBLE_ANSWER_WIRE_SCHEMA : COMPATIBLE_ACTION_WIRE_SCHEMA', after: 'schema: {}', pattern: '^HTTP adapters', test: 'test/adapters.test.ts' },
  { name: 'strict compatible union nodes', file: 'src/action-schema.ts', before: 'return { anyOf: schema.anyOf.map(strictSchema) }', after: 'return { ...schema, anyOf: schema.anyOf.map(strictSchema) }', pattern: '^constrained compatible', test: 'test/constrained.test.ts' },
  { name: 'shared schema validation', file: 'src/action-schema.ts', before: '!acceptsSchema(ACTION_SCHEMA, value)', after: 'false', pattern: '^constrained schema', test: 'test/constrained.test.ts' },
];
for (const proof of proofs) {
  const original = readFileSync(proof.file, 'utf8');
  try {
    writeFileSync(proof.file, replaceFixed(original, proof.before, proof.after, proof.name, 'occurrences' in proof ? proof.occurrences : 1));
    assertRegression(proof.test, proof.pattern, 120000, /ERR_ASSERTION|Recorded (partition|parse) refusal differs/);
    console.log(`${proof.name}: regression fails with only its production behavior reverted`);
  } finally { writeFileSync(proof.file, original); assert.equal(readFileSync(proof.file, 'utf8'), original); }
}
console.log(`${proofs.length}/${proofs.length} review revert proofs; source restored byte-for-byte`);
