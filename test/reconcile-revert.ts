/** Behavioral reverts require assertion failures and restore the exact edited function bytes. */
import { proveRevert } from './revert-source.ts';
const tests = 'test/reconcile.test.ts';
proveRevert({ name: 'caller reservation admission', file: 'src/reconcile.ts', before: 'allocated > Math.min(options.reserved_tokens, settings.budget_tokens)', after: 'allocated > settings.budget_tokens', pattern: '^paired admission refuses' }, tests);
proveRevert({ name: 'same immutable corpus across arms', file: 'src/reconcile.ts', before: '}, structuredClone(corpus));', after: '});', pattern: '^paired evidence preserves' }, tests);
proveRevert({ name: 'conflicting answers remain disagreement', file: 'src/reconcile.ts', before: "? 'equal_text' : 'disagreement'", after: "? 'equal_text' : 'equal_text'", pattern: '^paired evidence preserves' }, tests);
proveRevert({ name: 'history cannot cross the input boundary', file: 'src/engine.ts', before: "state.snapshot_only === true && action.action === 'history'", after: "false && action.action === 'history'", pattern: '^paired history refusal' }, tests);
proveRevert({ name: 'immutable flag validation', file: 'src/ledger.ts', before: 'decoded.snapshot_only !== undefined && decoded.snapshot_only !== true', after: 'false', pattern: '^paired evidence preserves' }, tests);
const concurrency = 'test/checkpoint-concurrency.test.ts';
proveRevert({ name: 'cleanup reads only inside its lease', file: 'src/ledger.ts', before: `    const unlock = await this.lease(run);
    try {
      const state = await this.load(run);`, after: `    const state = await this.load(run);
    const unlock = await this.lease(run);
    try {`, pattern: '^cleanup resume interleavings' }, concurrency);
proveRevert({ name: 'cleanup preserves terminal calls', file: 'src/ledger.ts', before: "if (call.result !== undefined || call.failure !== undefined) skipped.push(call.id);", after: "if (false) skipped.push(call.id);", pattern: '^cleanup resume interleavings' }, concurrency);
proveRevert({ name: 'native SDK compare-and-set', file: 'src/ledger.ts', before: "document.metadata.rlm_state !== expected || document.metadata.rlm_run !== state.run || !document.metadata.tags.includes('rlm:call') || document.metadata.parent !== state.calls[0].parent || current !== version", after: 'false', pattern: '^SDK compare-and-set' }, concurrency);
proveRevert({ name: 'completion uses durable counters', file: 'src/ledger.ts', before: 'const state = await this.load(snapshot.run);', after: 'const state = snapshot;', pattern: '^completion materialization' }, concurrency);
proveRevert({ name: 'read provenance captured before asynchronous work', file: 'src/ledger.ts', before: 'this.reads.set(state, { lease, checkpoint: root.rlm_state });', after: 'this.reads.set(state, { lease: this.leases.get(run), checkpoint: root.rlm_state });', pattern: '^load captures lease provenance' }, concurrency);
console.log('10/10 paired reconciliation behavioral revert proofs passed');
