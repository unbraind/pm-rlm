/** Verify each review correction and wire contract with its behavior independently removed. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const proofs = [
  { name: 'checkpoint parser selection', file: 'src/engine.ts', before: 'state.parser_version ?? 1', after: '3', all: true, pattern: '^parser versions', test: 'test/constrained.test.ts' },
  { name: 'strict legacy parser', file: 'src/protocol.ts', before: 'version === 1 ? output : extractObject(output)', after: 'extractObject(output)', pattern: '^parser versions', test: 'test/constrained.test.ts' },
  { name: 'URL-decoded source paths', file: 'test/live.ts', before: 'fileURLToPath(new URL(`../../../fleet/${repo}/`, base))', after: 'new URL(`../../../fleet/${repo}/`, base).pathname', pattern: '^live source URL', test: 'test/constrained.test.ts' },
  { name: 'Ollama action schema', file: 'src/adapters.ts', before: "format: legacy ? 'json' : schema", after: "format: 'json'", pattern: '^HTTP adapters', test: 'test/adapters.test.ts' },
  { name: 'OpenAI-compatible action schema', file: 'src/adapters.ts', before: 'schema: answer ? COMPATIBLE_ANSWER_SCHEMA : COMPATIBLE_ACTION_SCHEMA', after: 'schema: {}', pattern: '^HTTP adapters', test: 'test/adapters.test.ts' },
  { name: 'strict compatible union nodes', file: 'src/action-schema.ts', before: 'return { anyOf: schema.anyOf.map(strictSchema) }', after: 'return { ...schema, anyOf: schema.anyOf.map(strictSchema) }', pattern: '^constrained compatible', test: 'test/constrained.test.ts' },
  { name: 'shared schema validation', file: 'src/action-schema.ts', before: '!acceptsSchema(ACTION_SCHEMA, value)', after: 'false', pattern: '^constrained schema', test: 'test/constrained.test.ts' },
];
for (const proof of proofs) {
  const original = readFileSync(proof.file, 'utf8');
  assert.ok(original.includes(proof.before));
  try {
    writeFileSync(proof.file, proof.all ? original.replaceAll(proof.before, proof.after) : original.replace(proof.before, proof.after));
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', proof.pattern, proof.test], { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION|Recorded partition refusal differs/);
    console.log(`${proof.name}: regression fails with only its production behavior reverted`);
  } finally { writeFileSync(proof.file, original); assert.equal(readFileSync(proof.file, 'utf8'), original); }
}
console.log(`${proofs.length}/${proofs.length} review revert proofs; source restored byte-for-byte`);
