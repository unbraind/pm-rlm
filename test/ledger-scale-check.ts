import assert from 'node:assert/strict';
import type { RlmLedger } from '../src/ledger.ts';

/** Refuse benchmark success if collection removes any blob or leaves sampled roots unreadable. */
export async function verifyScaleCollection(ledger: RlmLedger): Promise<void> {
  assert.equal((await ledger.gc()).removed, 0, 'Scale fixture has no orphan blobs');
  for (const run of [1, 250, 500]) await ledger.load(`scale-run-${run}`);
}
