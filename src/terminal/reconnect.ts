/**
 * Pure auto-reconnect policy (Phase 5): the backoff schedule and the decision
 * of whether another attempt is allowed. No timers, no DOM — unit-tested in
 * `reconnect.test.ts`; the `TerminalPane` drives the actual timers.
 *
 * SPEC/PLAN Phase 5: on an unexpected drop, retry with backoff (2s / 4s / 8s),
 * max 5 attempts, with a cancel control in the overlay.
 */

export const MAX_RECONNECT_ATTEMPTS = 5;

const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 8000;

/**
 * Backoff delay before the given attempt (1-based): 2s, 4s, 8s, then capped at
 * 8s for the remaining attempts.
 */
export function reconnectDelayMs(attempt: number): number {
  if (attempt < 1) return BASE_DELAY_MS;
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

/**
 * Whether another automatic attempt is allowed: only when the device opted in
 * and we haven't exhausted the attempt budget. `attemptsSoFar` is the number of
 * automatic attempts already made (0 before the first).
 */
export function canReconnect(autoReconnect: boolean, attemptsSoFar: number): boolean {
  return autoReconnect && attemptsSoFar < MAX_RECONNECT_ATTEMPTS;
}
