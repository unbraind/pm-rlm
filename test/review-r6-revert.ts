/** Prove package targets and both execution-refusal entry points with independent source reversions. */
import { proveRevert } from './revert-source.ts';

const artifacts = `    "eval-results.json",
    "eval-results-v2.json",
    "eval-results-constrained.json",
    "docs/EVAL-V2.md",
    "docs/EVAL-CONSTRAINED.md",
    "docs/ACTION-DIAGNOSIS.md"`;
const modelCharge = `        state.reserved_tokens += step.response !== undefined && step.settled !== true
          ? step.response.tokens_in + step.response.tokens_out
          : step.reserved;\n`;
const refusalCheck = "          if (refusal === undefined || observation.refused !== refusal.code || (!legacyCodeOnly && (!('reason' in observation) || observation.reason !== refusal.message)))";
const proofs = [
  { name: 'installed report targets', file: 'package.json', before: artifacts, after: '    "eval-results.json"', pattern: '^review r6 packed' },
  { name: 'replay execution-refusal validation', file: 'src/engine.ts', before: '  await new RlmEngine(ledger, state, new HttpModel(state.settings)).validateRecorded();\n', after: '', pattern: '^review r6 replay rejects' },
  { name: 'resume execution-refusal validation', file: 'src/engine.ts', before: '      await this.validateRecorded();\n', after: '', pattern: '^review r6 resume rejects' },
  { name: 'chronological model budget', file: 'src/engine.ts', before: modelCharge, after: '', pattern: '^review r6 execution refusal budgets' },
  { name: 'legacy unsettled response usage', file: 'src/engine.ts', before: modelCharge, after: '        state.reserved_tokens += step.reserved;\n', pattern: '^review r7' },
  { name: 'legacy code-only execution refusal', file: 'src/engine.ts', before: refusalCheck, after: "          if (refusal === undefined || observation.refused !== refusal.code || !('reason' in observation) || observation.reason !== refusal.message)", pattern: '^review r7' },
];
for (const proof of proofs) proveRevert(proof, 'test/review-r6.test.ts', 180000);
console.log(`${proofs.length}/${proofs.length} review behavioral revert proofs; source restored byte-for-byte`);
