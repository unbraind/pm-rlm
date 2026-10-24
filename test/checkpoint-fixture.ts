import { RlmBlobs } from '../src/blobs.ts';
import type { RlmLedger } from '../src/ledger.ts';
import type { TestContext } from 'node:test';
import type { RlmState } from '../src/types.ts';

/** Deliberately replace valid or corrupt fixture evidence through the real SDK, outside the production save API. */
export async function replaceCheckpointFixture(ledger: RlmLedger, state: RlmState): Promise<void> {
  const unlock = await ledger.lease(state.run);
  try {
    const checkpoint = await new RlmBlobs(ledger.workspace).encode(state);
    await ledger.client.run('update', { id: state.run, options: { rlmState: checkpoint, message: 'Install checkpoint test fixture' } });
  } finally { await unlock(); }
}

/** Hold a lease until test cleanup and read the writable state only after acquisition. */
export async function leasedFixture(t: TestContext, ledger: RlmLedger, run: string): Promise<RlmState> {
  const unlock = await ledger.lease(run);
  t.after(unlock);
  return ledger.load(run);
}
