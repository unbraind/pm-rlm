/** Revert one behavior at a time; always restore exact authored source bytes. */
import { proveRevert } from './revert-source.ts';
const file = 'test/evaluation.test.ts';
if (process.argv[2] !== '--review-only') {
proveRevert({ name: 'twenty-question minimum', file: 'src/evaluation.ts', before: 'integer(suite.questions.length, 20, 100)', after: 'integer(suite.questions.length, 1, 100)', pattern: '^evaluation validates' }, file);
proveRevert({ name: 'frozen source digest', file: 'src/evaluation.ts', before: 'if (evalDigest(JSON.stringify(corpus.items)) !== source.corpus_sha256)', after: 'if (false)', pattern: '^evaluation validates' }, file);
proveRevert({ name: 'bounded UTF-8 truncation', file: 'src/evaluation.ts', before: 'settings.context_tokens - settings.output_tokens - Buffer.byteLength(prefix)', after: 'settings.context_tokens - Buffer.byteLength(prefix)', pattern: '^evaluation truncation' }, file);
proveRevert({ name: 'foreign receipt skip reason', file: 'src/evaluation.ts', before: "reason = 'foreign_record_preserved'", after: "reason = 'unrecognized_record'", pattern: '^evaluation preserves' }, file);
proveRevert({ name: 'failed request usage remains unknown', file: 'src/evaluation.ts', before: 'tokens_in: failed_requests > 0 ? null : tokens_in', after: 'tokens_in: tokens_in', pattern: '^evaluation counts' }, file);
proveRevert({ name: 'evaluation outer lease', file: 'src/evaluation.ts', before: 'const release = await ledger.lease(evaluation);', after: 'const release = async () => {};', pattern: '^evaluation interleaving' }, file);
proveRevert({ name: 'description CAS preserves native peer edits', file: 'src/evaluation.ts', before: "match: { key: 'description', value: previous.value }, ", after: '', pattern: '^evaluation interleaving' }, file);
proveRevert({ name: 'pending arm never silently retried after crash', file: 'src/evaluation.ts', before: 'if (state.pending !== undefined)', after: 'if (false)', pattern: '^evaluation crash' }, file, 300000);
proveRevert({ name: 'native no-git command registration', file: 'src/commands.ts', before: "name: 'rlm eval', description:", after: "name: 'rlm eval-disabled', description:", pattern: '^evaluation host' }, file);
proveRevert({ name: 'failed child reach measurement', file: 'src/evaluation.ts', before: 'recursive.children = observedChildren;', after: 'recursive.children = 0;', pattern: '^evaluation records child' }, file);
proveRevert({ name: 'malformed response refusal classification', file: 'src/evaluation.ts', before: "refusal = error instanceof RlmError ? error.code : 'incomplete'", after: "refusal = error instanceof RlmError ? error.code : 'model'", pattern: '^evaluation counts' }, file);
proveRevert({ name: 'immutable evaluation declarations', file: 'src/evaluation.ts', before: '...structuredClone(declarations), stub, on_boundary', after: '...declarations, stub, on_boundary', pattern: '^evaluation measures' }, file);
}
proveRevert({ name: 'interrupted child observation is unknown', file: 'src/evaluation.ts', before: "refusal: 'interrupted', failed_requests: null, children: null", after: "refusal: 'interrupted', failed_requests: null, children: 0", pattern: '^evaluation interrupted children' }, file);
proveRevert({ name: 'unknown child totals propagate', file: 'src/evaluation.ts', before: "children: total(rows, 'children')", after: "children: rows.reduce((sum, row) => sum + (row.children ?? 0), 0)", pattern: '^evaluation interrupted children' }, file);
proveRevert({ name: 'legacy interrupted child receipts remain unknown', file: 'src/evaluation.ts', before: "if (arm.refusal === 'interrupted') arm.children = null;", after: 'void arm;', pattern: '^evaluation interrupted children' }, file);
proveRevert({ name: 'native unknown metrics survive host compaction', file: 'src/commands.ts', before: "count === null ? 'unknown' : count", after: 'count', pattern: '^evaluation interrupted children' }, file);
console.log(process.argv[2] === '--review-only' ? '4/4 evaluation review revert proofs passed' : '16/16 evaluation behavioral revert proofs passed');
