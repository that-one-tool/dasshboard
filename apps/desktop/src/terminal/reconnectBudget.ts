/**
 * One auto-reconnect sequence, with the policy of `reconnect.ts`: backoff
 * timer, attempt count, and the keychain failures that end it. Shared by the
 * terminal panes (one each) and the Tunnels panel (one per device).
 */

import type { ErrorCode } from "../ipc";
import {
  canReconnect,
  countKeyringFailure,
  isRetryableFailure,
  reconnectDelayMs,
} from "./reconnect";

export class ReconnectBudget {
  private attemptCount = 0;
  private keyringFailures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly retry: () => void) {}

  get attempts(): number {
    return this.attemptCount;
  }

  /** Whether a sequence has started and not ended (reset) since. */
  isInProgress(): boolean {
    return this.attemptCount > 0;
  }

  /** The session ended unexpectedly (`code`: its error, if any). Schedules a
   * retry and returns `true`, or returns `false` (and resets) when it should
   * stay down. */
  schedule(autoReconnect: boolean, code?: ErrorCode): boolean {
    this.keyringFailures = countKeyringFailure(code, this.keyringFailures);
    if (!this.allowed(autoReconnect, code)) {
      this.reset();
      return false;
    }
    this.attemptCount += 1;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.retry();
    }, reconnectDelayMs(this.attemptCount));
    return true;
  }

  /** Back up, or the user took over: cancel any pending retry and give the
   * next drop a full budget. */
  reset(): void {
    this.clearTimer();
    this.attemptCount = 0;
    this.keyringFailures = 0;
  }

  private allowed(autoReconnect: boolean, code?: ErrorCode): boolean {
    if (!isRetryableFailure(code, this.keyringFailures)) return false;
    return canReconnect(autoReconnect, this.attemptCount);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
