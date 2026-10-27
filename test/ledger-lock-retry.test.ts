import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireLock, createPmCliExpectedError, isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { RlmLedger } from '../src/ledger.ts';
import { retryDeadOwnerLock } from '../src/lock-retry.ts';
import { testEnvironment } from '../scripts/environment.ts';
import { tracker } from './helpers.ts';

/** Build one real lock-conflict expected error for retry-contract checks. */
function lockConflict(reason: 'lock_owner_dead' | 'lock_owner_alive', retryAfterMs?: number) {
  return createPmCliExpectedError(`Item probe is locked (owner pm-rlm) (owner process ${reason === 'lock_owner_dead' ? 'dead' : 'alive'})`, { exitCode: 2, context: { code: 'lock_conflict', item_id: 'probe', reason, ...(retryAfterMs === undefined ? {} : { recovery: { retry_after_ms: retryAfterMs } }) } });
}

/** Dead-owner conflicts are retried within budget; live owners and other errors fail fast unchanged. */
test('dead-owner retry is bounded, jittered and refuses live owners', async () => {
  let liveAttempts = 0;
  await assert.rejects(retryDeadOwnerLock(async () => { liveAttempts += 1; throw lockConflict('lock_owner_alive', 1); }, 10_000), (error: unknown) => isPmCliExpectedError(error) && error.code === 'lock_conflict' && error.context.reason === 'lock_owner_alive');
  assert.equal(liveAttempts, 1, 'A live owner must fail fast without retry');
  let nonLockAttempts = 0;
  await assert.rejects(retryDeadOwnerLock(async () => { nonLockAttempts += 1; throw new Error('transport refused'); }, 10_000), /transport refused/);
  assert.equal(nonLockAttempts, 1, 'Non-lock errors must not be retried');
  let recoveredAttempts = 0;
  assert.equal(await retryDeadOwnerLock(async () => { recoveredAttempts += 1; if (recoveredAttempts < 3) throw lockConflict('lock_owner_dead', 1); return 'written'; }, 10_000), 'written');
  assert.equal(recoveredAttempts, 3, 'A dead-owner conflict writes nothing and is safely retried');
  let exhaustedAttempts = 0;
  const exhaustedStart = Date.now();
  await assert.rejects(retryDeadOwnerLock(async () => { exhaustedAttempts += 1; throw lockConflict('lock_owner_dead'); }, 300), (error: unknown) => isPmCliExpectedError(error) && error.context.reason === 'lock_owner_dead');
  assert.ok(exhaustedAttempts > 1, 'The budget must cover at least one retry');
  assert.ok(Date.now() - exhaustedStart < 10_000, 'A permanently blocked dead owner must fail after the budget, never hang');
  let withoutHintAttempts = 0;
  await retryDeadOwnerLock(async () => { withoutHintAttempts += 1; if (withoutHintAttempts < 2) throw lockConflict('lock_owner_dead'); return 'written'; }, 10_000);
  assert.equal(withoutHintAttempts, 2, 'The default backoff applies when no retry hint is published');
});

/** Kill a real lock holder mid-lease, leaving a dead-owner lock behind. */
async function killLockHolder(t: Parameters<typeof tracker>[0], workspace: string, lockName: string): Promise<void> {
  const child = fork(join(import.meta.dirname, 'lock-retry-worker.ts'), [workspace, lockName], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: testEnvironment(process.env) });
  t.after(() => { child.kill('SIGKILL'); });
  const [held] = await once(child, 'message') as [{ held: boolean } | null];
  assert.ok(held?.held);
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  assert.deepEqual(await exit, [null, 'SIGKILL']);
}

/** A live owner's lock on the run lease refuses the ledger mutation immediately, without the retry budget. */
test('live-owner lock conflicts fail fast without the dead-owner retry budget', async t => {
  const { workspace } = await tracker(t);
  const ledger = new RlmLedger(workspace, 'pm-rlm', { deadOwnerRetryMs: 15_000 });
  const unlock = await acquireLock(workspace, 'rlm-lease-live-run', 60, 'rlm-live-owner', false, false, 200);
  try {
    const startedAt = Date.now();
    await assert.rejects(ledger.lease('live-run'), (error: unknown) => isPmCliExpectedError(error) && error.code === 'lock_conflict' && error.context.reason === 'lock_owner_alive');
    assert.ok(Date.now() - startedAt < 10_000, 'A live owner must not consume the dead-owner retry budget');
  } finally { await unlock(); }
});

/** A permanently fenced dead owner fails with the typed lock conflict after the configured budget. */
test('permanently fenced dead-owner lock fails with the typed error after the budget', async t => {
  const { workspace } = await tracker(t);
  const run = 'dead-run';
  const lockName = `rlm-lease-${run}`;
  await killLockHolder(t, workspace, lockName);
  // Recreate the upstream regression: a fresh commit-fence cleanup gate held by a live process
  // blocks dead-owner takeover forever (unbraind/pm-cli#1609 leaves such a gate per killed writer).
  const gate = join(workspace, 'locks', `${lockName}.lock.stale-cleanup`);
  await mkdir(gate, { recursive: true });
  await writeFile(join(gate, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'rlm-test-live-gate' }));
  const ledger = new RlmLedger(workspace, 'pm-rlm', { deadOwnerRetryMs: 1_500 });
  const startedAt = Date.now();
  await assert.rejects(ledger.lease(run), (error: unknown) => isPmCliExpectedError(error) && error.code === 'lock_conflict' && error.context.reason === 'lock_owner_dead');
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 1_500, 'The retry budget must be spent before failing');
  assert.ok(elapsedMs < 15_000, 'A permanently blocked dead owner must fail bounded, never hang');
});

/** A dead owner without a fresh gate is taken over immediately; retries then converge on success. */
test('unfenced dead-owner lease is reclaimed and released by the retrying ledger', async t => {
  const { workspace } = await tracker(t);
  const run = 'reclaimed-run';
  const lockName = `rlm-lease-${run}`;
  await killLockHolder(t, workspace, lockName);
  const ledger = new RlmLedger(workspace, 'pm-rlm', { deadOwnerRetryMs: 15_000 });
  const unlock = await ledger.lease(run);
  await unlock();
  const release = await ledger.lease(run);
  await release();
});