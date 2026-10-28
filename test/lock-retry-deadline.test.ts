import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPmCliExpectedError, isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { RlmLedger } from '../src/ledger.ts';
import { RlmError } from '../src/errors.ts';
import { retryDeadOwnerLock, retryWithinBudget } from '../src/lock-retry.ts';
import { tracker } from './helpers.ts';

/** Preserve a real SDK typed refusal, including a published or malformed retry hint. */
function deadOwner(hint?: number) {
  return createPmCliExpectedError('Dead owner still fenced', { exitCode: 2, context: { code: 'lock_conflict', reason: 'lock_owner_dead', recovery: { retry_after_ms: hint } } });
}

/** A short budget must not sleep for a long hint or start a successful write at expiry. */
test('dead-owner retry caps a 2000 ms hint to the remaining 10 ms and refuses the next write', async () => {
  let now = 0;
  let attempts = 0;
  const sleeps: number[] = [];
  const error = deadOwner(2000);
  await assert.rejects(retryDeadOwnerLock(async () => {
    attempts += 1;
    if (attempts === 1) throw error;
    return 'write after expiry';
  }, 10, { now: () => now, random: () => 0.5, sleep: async ms => { sleeps.push(ms); now += ms; } }), failure => failure === error);
  assert.deepEqual(sleeps, [10]);
  assert.equal(attempts, 1);
  assert.equal(now, 10);
});

/** Hint, backoff, jitter and remaining budget independently constrain every sleep. */
test('dead-owner retries obey exact capped exponential backoff and small hints', async () => {
  for (const [hint, jitter, budget, expected] of [
    [9000, 0.5, 6000, [250, 500, 1000, 2000, 2000, 250]],
    [9000, 0, 2000, [125, 250, 500, 1000, 125]],
    [9000, 0.999, 5000, [375, 750, 1499, 2000, 376]],
    [10, 0.999, 35, [10, 10, 10, 5]],
  ] as const) {
    let now = 0;
    const sleeps: number[] = [];
    const starts: number[] = [];
    const error = deadOwner(hint);
    await assert.rejects(retryDeadOwnerLock(async () => { starts.push(now); throw error; }, budget, {
      now: () => now, random: () => jitter, sleep: async ms => { sleeps.push(ms); now += ms; },
    }), failure => failure === error);
    assert.deepEqual(sleeps, expected);
    assert.equal(starts.length, sleeps.length);
    assert.ok(starts.every(start => start < budget));
  }
});

/** Sweep deadlines, malformed hints, jitter endpoints, slow attempts and late wakeups. */
test('every dead-owner retry schedule respects the deadline and preserves its typed refusal', async () => {
  for (const budget of [0, 1, 10, 249, 250, 251, 2001]) {
    for (const hint of [undefined, -1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1, 10, 2000, 9000]) {
      for (const jitter of [0, 0.5, 0.999]) {
        for (const oversleep of [0, 1, 5000]) {
          let now = 0;
          let attempts = 0;
          const error = deadOwner(hint);
          await assert.rejects(retryDeadOwnerLock(async () => {
            assert.ok(now < budget, 'No mutation may start at or after expiry');
            attempts += 1;
            now += 1;
            throw error;
          }, budget, { now: () => now, random: () => jitter, sleep: async ms => {
            const ceiling = typeof hint === 'number' && Number.isSafeInteger(hint) && hint > 0 ? hint : 2000;
            assert.ok(ms > 0 && ms <= Math.min(ceiling, 2000, budget - now));
            now += ms + oversleep;
          } }), failure => attempts === 0
            ? isPmCliExpectedError(failure) && failure.code === 'lock_conflict'
            : failure === error);
          assert.ok(now >= budget);
        }
      }
    }
  }
});

/** A deadline may expire before the initial attempt or while an SDK call is in flight. */
test('dead-owner deadline checks cover initial expiry, slow failures and slow successful calls', async () => {
  const error = deadOwner(2000);
  let reads = 0;
  await assert.rejects(retryDeadOwnerLock(async () => { assert.fail('Expired first attempt ran'); }, 10, {
    now: () => reads++ === 0 ? 0 : 10,
  }), failure => isPmCliExpectedError(failure) && failure.code === 'lock_conflict');
  let now = 0;
  let sleeps = 0;
  await assert.rejects(retryDeadOwnerLock(async () => { now = 11; throw error; }, 10, {
    now: () => now, sleep: async () => { sleeps += 1; },
  }), failure => failure === error);
  assert.equal(sleeps, 0);
  now = 0;
  assert.equal(await retryDeadOwnerLock(async () => { now = 11; return 'committed'; }, 10, { now: () => now }), 'committed');
});

/** The storage busy policy uses the same guard as typed lock conflicts, including late wakeups. */
test('all bounded retry policies prevent attempts at expiry and preserve unrelated errors', async () => {
  for (const delay of [1, 25, 2000]) {
    for (const oversleep of [0, 1000]) {
      let now = 0;
      let attempts = 0;
      const error = new Error('busy');
      const sleeps: number[] = [];
      await assert.rejects(retryWithinBudget(async () => { assert.ok(now < 10); attempts += 1; throw error; }, 10, {
        delayMs: () => delay, exhaustedError: error,
      }, { now: () => now, sleep: async ms => { sleeps.push(ms); now += ms + oversleep; } }), failure => failure === error);
      assert.equal(attempts, sleeps.length);
      assert.ok(sleeps.every(ms => ms <= Math.min(delay, 10)));
    }
  }
  const unrelated = new Error('transport');
  await assert.rejects(retryWithinBudget(async () => { throw unrelated; }, 10000, {
    delayMs: () => undefined, exhaustedError: new Error('expired'),
  }), failure => failure === unrelated);
});

/** A zero deadline prevents real SDK mutations in a tracker with no Git repository. */
test('zero retry budget refuses real non-git ledger mutations before side effects', async t => {
  const { root, workspace, client } = await tracker(t);
  assert.equal(existsSync(join(root, '.git')), false);
  const before = (await client.schemaListFields()).fields;
  const ledger = new RlmLedger(workspace, 'deadline-test', { deadOwnerRetryMs: 0 });
  for (const mutation of [() => ledger.registerFields(), () => ledger.lease('expired-run')]) {
    await assert.rejects(mutation(), failure => isPmCliExpectedError(failure) && failure.code === 'lock_conflict');
  }
  assert.deepEqual((await client.schemaListFields()).fields, before);
  assert.equal(existsSync(join(workspace, 'runtime', 'rlm-expired-run.json')), false);
});

/** A real busy storage lease becomes available only after the outer deadline has elapsed. */
test('non-git storage retries never acquire an available lease after their deadline', async t => {
  const { workspace } = await tracker(t);
  const owner = new RlmLedger(workspace);
  const release = await owner.lease('__blob_store');
  t.after(release);
  let now = 0;
  const sleeps: number[] = [];
  const contender = new RlmLedger(workspace, 'storage-contender', { retryTiming: {
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now = 60_000; await release(); },
  } });
  await assert.rejects(contender.gc(), failure => failure instanceof RlmError && failure.code === 'busy');
  assert.deepEqual(sleeps, [25]);
  assert.equal(existsSync(join(workspace, 'runtime', 'rlm-__blob_store.json')), false);
});
