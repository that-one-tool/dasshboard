/**
 * Pure auto-reconnect policy (Phase 5): the backoff schedule and the decision
 * of whether another attempt is allowed. No timers, no DOM — unit-tested in
 * `reconnect.test.ts`; the `TerminalPane` drives the actual timers.
 *
 * SPEC/PLAN Phase 5: on an unexpected drop, retry with backoff (2s / 4s / 8s),
 * max 5 attempts, with a cancel control in the overlay.
 */

import type { ErrorCode } from "../ipc";

export const MAX_RECONNECT_ATTEMPTS = 5;

/** Failures a retry would only repeat: a wrong password (each try counts
 * toward a server lockout / fail2ban ban), a host key the user rejected (it
 * would prompt again), an invalid or deleted device. */
const FINAL_FAILURES: ReadonlySet<ErrorCode> = new Set([
  "SshAuth",
  "HostKeyRejected",
  "Validation",
  "NotFound",
]);

/** A keychain that is locked or not ready yet (at login, after resume) gets
 * this many retries; then the failure is final like the others. */
const KEYRING_RETRIES = 1;

/** Whether a session end with this error code (none for a plain drop) is
 * worth an automatic retry. `keyringFailures` counts the keychain failures of
 * the current reconnect sequence, this one included. */
export function isRetryableFailure(code?: ErrorCode, keyringFailures = 0): boolean {
  if (code === "Keyring") return keyringFailures <= KEYRING_RETRIES;
  return code === undefined || !FINAL_FAILURES.has(code);
}

/** The keychain-failure count after a session end with `code`. */
export function countKeyringFailure(code: ErrorCode | undefined, soFar: number): number {
  return code === "Keyring" ? soFar + 1 : soFar;
}

/** The `code` of an `AppError` rejected by a command, if `err` is one. */
export function errorCodeOf(err: unknown): ErrorCode | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return (err as { code: ErrorCode }).code;
}

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
