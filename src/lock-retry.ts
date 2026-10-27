import { createPmCliExpectedError, isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import type { PmCliExpectedError } from '@unbrained/pm-cli/sdk';
import { integer } from './errors.ts';

/** Default total millisecond budget one mutation may spend retrying a dead owner's fenced lock. */
export const DEFAULT_DEAD_OWNER_RETRY_MS = 15_000;
/** Default first backoff delay, shared with the SDK's published lock-conflict retry hint. */
const BASE_RETRY_DELAY_MS = 250;
/** Upper bound for the backoff delay between dead-owner retry attempts. */
const MAX_RETRY_DELAY_MS = 2_000;

/** True when a refused SDK mutation hit an item lock whose recorded owner process is provably dead; nothing was written. */
export function isDeadOwnerLockConflict(error: unknown): error is PmCliExpectedError {
  return isPmCliExpectedError(error) && error.code === 'lock_conflict' && error.context.reason === 'lock_owner_dead';
}

/** Exponential backoff with jitter, capped by a valid SDK hint and the maximum delay. */
function backoffDelayMs(error: PmCliExpectedError, attempt: number, random: () => number): number {
  const hint = error.context.recovery?.retry_after_ms;
  const ceiling = typeof hint === 'number' && Number.isSafeInteger(hint) && hint > 0 ? hint : MAX_RETRY_DELAY_MS;
  const grown = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return Math.min(ceiling, MAX_RETRY_DELAY_MS, Math.max(1, Math.round(grown * (0.5 + random()))));
}

/** Injectable monotonic time and scheduling boundaries for every bounded mutation retry. */
export interface RetryTiming {
  /** Monotonic elapsed milliseconds, independent of wall-clock adjustments. */
  now: () => number;
  /** Sleep for the requested milliseconds; waking late must never authorize another attempt. */
  sleep: (milliseconds: number) => Promise<void>;
  /** Jitter sample in the interval [0, 1). */
  random: () => number;
}

/** Error classification and backoff policy shared by deadline-guarded retry loops. */
interface RetryPolicy {
  /** Return a positive delay for retryable errors, or undefined to refuse unchanged. */
  delayMs: (error: unknown, attempt: number) => number | undefined;
  /** Typed refusal if the deadline expires before the first attempt. */
  exhaustedError: Error;
}

/** Run only attempts started before the deadline, preserving the last refusal at exhaustion. */
export async function retryWithinBudget<T>(operation: () => Promise<T>, budgetMs: number, policy: RetryPolicy, timing: Partial<RetryTiming> = {}): Promise<T> {
  const now = timing.now ?? (() => performance.now());
  const sleep = timing.sleep ?? (async milliseconds => { await new Promise(resolve => { setTimeout(resolve, milliseconds); }); });
  const deadline = now() + integer(budgetMs, 0);
  let lastError: unknown = policy.exhaustedError;
  let attempt = 0;
  for (;;) {
    if (now() >= deadline) throw lastError;
    try { return await operation(); }
    catch (error) {
      const delay = policy.delayMs(error, attempt);
      if (delay === undefined) throw error;
      lastError = error;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw error;
      await sleep(Math.min(delay, remainingMs));
      attempt += 1;
    }
  }
}

/**
 * Retry an SDK mutation whose item lock is still fenced by a dead previous writer.
 *
 * The pinned SDK (unbraind/pm-cli#1609) leaves a fresh commit-fence cleanup gate when a
 * writer is killed inside `lease.fence()`, and that gate blocks dead-owner takeover for
 * about ten seconds while the default item-lock wait is three seconds. A `lock_conflict`
 * whose recorded owner process is provably dead wrote nothing, so the same mutation is
 * retried with bounded backoff and jitter until `budgetMs` elapses; every other
 * `lock_conflict` reason (a live owner) and every other error fails fast unchanged.
 *
 * @param operation SDK mutation to run; retried whole because a refused lock conflict committed nothing.
 * @param budgetMs Total millisecond budget for attempts and backoff; zero refuses without a mutation.
 * @param timing Optional clock, sleeper and jitter overrides for deterministic deadline checks.
 * @returns The mutation's result after a successful attempt.
 */
export async function retryDeadOwnerLock<T>(operation: () => Promise<T>, budgetMs: number = DEFAULT_DEAD_OWNER_RETRY_MS, timing: Partial<RetryTiming> = {}): Promise<T> {
  return retryWithinBudget(operation, budgetMs, {
    delayMs: (error, attempt) => isDeadOwnerLockConflict(error) ? backoffDelayMs(error, attempt, timing.random ?? Math.random) : undefined,
    exhaustedError: createPmCliExpectedError('Dead-owner lock retry budget exhausted before mutation', { exitCode: 2, context: { code: 'lock_conflict', reason: 'retry_budget_exhausted' } }),
  }, timing);
}
