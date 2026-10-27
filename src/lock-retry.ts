import { isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
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

/** Backoff before the next retry attempt: the SDK hint doubled per attempt, capped, with jitter. */
function backoffDelayMs(error: PmCliExpectedError, attempt: number): number {
  const hint = error.context.recovery?.retry_after_ms;
  const base = typeof hint === 'number' && Number.isSafeInteger(hint) && hint > 0 ? Math.min(hint, MAX_RETRY_DELAY_MS) : BASE_RETRY_DELAY_MS;
  const grown = Math.min(base * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return Math.max(1, Math.round(grown * (0.5 + Math.random())));
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
 * @param budgetMs Total millisecond budget for retries; zero disables retries.
 * @returns The mutation's result after a successful attempt.
 */
export async function retryDeadOwnerLock<T>(operation: () => Promise<T>, budgetMs: number = DEFAULT_DEAD_OWNER_RETRY_MS): Promise<T> {
  const deadline = Date.now() + integer(budgetMs, 0);
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isDeadOwnerLockConflict(error)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw error;
      await new Promise(resolve => { setTimeout(resolve, backoffDelayMs(error, attempt)); });
      attempt += 1;
    }
  }
}