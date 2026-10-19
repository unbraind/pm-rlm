/** Prove package targets and both execution-refusal entry points with independent source reversions. */
import { proveRevert } from './revert-source.ts';

const artifacts = `    "eval-results.json",
    "eval-results-v2.json",
    "eval-results-constrained.json",
    "docs/EVAL-V2.md",
    "docs/EVAL-CONSTRAINED.md",
    "docs/ACTION-DIAGNOSIS.md"`;
const proofs = [
  { name: 'installed report targets', file: 'package.json', before: artifacts, after: '    "eval-results.json"', pattern: '^review r6 packed' },
  { name: 'replay execution-refusal validation', file: 'src/engine.ts', before: '  await new RlmEngine(ledger, state, new HttpModel(state.settings)).validateRecorded();\n', after: '', pattern: '^review r6 replay rejects' },
  { name: 'resume execution-refusal validation', file: 'src/engine.ts', before: '      await this.validateRecorded();\n', after: '', pattern: '^review r6 resume rejects' },
  { name: 'chronological model budget', file: 'src/engine.ts', before: '        state.reserved_tokens += step.reserved;\n', after: '', pattern: '^review r6 execution refusal budgets' },
];
for (const proof of proofs) proveRevert(proof, 'test/review-r6.test.ts', 180000);
console.log(`${proofs.length}/${proofs.length} round-six behavioral revert proofs; source restored byte-for-byte`);
