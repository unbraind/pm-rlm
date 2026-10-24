/** Behavioral reverts require assertion failures and restore the exact edited function bytes. */
import { proveRevert } from './revert-source.ts';
const tests = 'test/reconcile.test.ts';
proveRevert({ name: 'caller reservation admission', file: 'src/reconcile.ts', before: 'allocated > Math.min(options.reserved_tokens, settings.budget_tokens)', after: 'allocated > settings.budget_tokens', pattern: '^paired admission refuses' }, tests);
proveRevert({ name: 'same immutable corpus across arms', file: 'src/reconcile.ts', before: '}, structuredClone(corpus));', after: '});', pattern: '^paired evidence preserves' }, tests);
proveRevert({ name: 'conflicting answers remain disagreement', file: 'src/reconcile.ts', before: "? 'equal_text' : 'disagreement'", after: "? 'equal_text' : 'equal_text'", pattern: '^paired evidence preserves' }, tests);
proveRevert({ name: 'history cannot cross the input boundary', file: 'src/engine.ts', before: "state.snapshot_only === true && action.action === 'history'", after: "false && action.action === 'history'", pattern: '^paired history refusal' }, tests);
proveRevert({ name: 'immutable flag validation', file: 'src/ledger.ts', before: 'decoded.snapshot_only !== undefined && decoded.snapshot_only !== true', after: 'false', pattern: '^paired evidence preserves' }, tests);
console.log('5/5 paired reconciliation behavioral revert proofs passed');
