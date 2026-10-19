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
const spawnProofs = [
  { name: 'all ten spawn refusal kinds', file: 'src/engine.ts', before: '        const observation = step.observation;', after: "        if (action.action === 'spawn') continue;\n        const observation = step.observation;", pattern: '^review r8 spawn refusal' },
  { name: 'spawn refusal code comparison', file: 'src/engine.ts', before: 'observation.refused !== refusal.code', after: 'false', pattern: '^review r8 spawn refusal depth limit' },
  { name: 'spawn refusal reason comparison', file: 'src/engine.ts', before: "(!legacyCodeOnly && (!('reason' in observation) || observation.reason !== refusal.message))", after: 'false', pattern: '^review r8 spawn refusal slice scope' },
  { name: 'child failure message receipt', file: 'src/engine.ts', before: 'call.failure = { code: error.code, reason: error.message };', after: 'call.failure = { code: error.code };', pattern: '^review r8 spawn refusal child model failure' },
  { name: 'measured report invocation wording', file: 'docs/EVAL-V2.md', before: 'One authorized evaluation invocation', after: 'One authorized model invocation', pattern: '^review r8 report' },
  { name: 'measured report source wording', file: 'docs/EVAL-V2.md', before: 'the formatter finds and verifies the immutable commit reproducing every measured byte.', after: 'the formatter verifies they remain unchanged.', pattern: '^review r8 report' },
  { name: 'regenerated report source wording', file: 'test/report-v2.ts', before: 'the formatter finds and verifies the immutable commit reproducing every measured byte.', after: 'the formatter verifies they remain unchanged.', pattern: '^review r8 report' },
];
for (const proof of spawnProofs) proveRevert(proof, 'test/review-r8.test.ts', 180000);
const total = proofs.length + spawnProofs.length;
console.log(`${total}/${total} review behavioral revert proofs; source restored byte-for-byte`);
