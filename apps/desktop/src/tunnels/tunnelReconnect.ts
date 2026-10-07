/**
 * Auto-reconnect for tunnels, per device, with the terminal panes' policy
 * (`terminal/reconnect.ts`): only for a device that opted in, 2 s / 4 s / 8 s
 * backoff, a bounded number of attempts, and never for a failure a retry
 * would only repeat. DOM-free; the Tunnels panel decides when a tunnel ended
 * unexpectedly and what a retry starts.
 */

import type { ErrorCode } from "../ipc";
import {
  canReconnect,
  countKeyringFailure,
  isRetryableFailure,
  reconnectDelayMs,
} from "../terminal/reconnect";

interface Budget {
  attempts: number;
  keyringFailures: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TunnelReconnects {
  private readonly budgets = new Map<string, Budget>();

  constructor(private readonly retry: (deviceId: string) => void) {}

  /** A device's tunnel ended unexpectedly (`code`: its error, if any). Schedules
   * a retry and returns `true`, or returns `false` (and starts the next drop
   * from a full budget) when it should stay down. */
  schedule(deviceId: string, autoReconnect: boolean, code?: ErrorCode): boolean {
    const budget = this.budgetOf(deviceId);
    budget.keyringFailures = countKeyringFailure(code, budget.keyringFailures);
    if (!this.allowed(budget, autoReconnect, code)) {
      this.reset(deviceId);
      return false;
    }
    budget.attempts += 1;
    clearPending(budget);
    budget.timer = setTimeout(() => {
      budget.timer = null;
      this.retry(deviceId);
    }, reconnectDelayMs(budget.attempts));
    return true;
  }

  /** The tunnel is back up, or the user took over: cancel any pending retry
   * and give its next drop a full budget. */
  reset(deviceId: string): void {
    const budget = this.budgets.get(deviceId);
    if (budget) clearPending(budget);
    this.budgets.delete(deviceId);
  }

  /** Cancel every pending retry (the panel is going away). */
  dispose(): void {
    for (const budget of this.budgets.values()) clearPending(budget);
    this.budgets.clear();
  }

  private allowed(budget: Budget, autoReconnect: boolean, code?: ErrorCode): boolean {
    if (!isRetryableFailure(code, budget.keyringFailures)) return false;
    return canReconnect(autoReconnect, budget.attempts);
  }

  private budgetOf(deviceId: string): Budget {
    let budget = this.budgets.get(deviceId);
    if (!budget) {
      budget = { attempts: 0, keyringFailures: 0, timer: null };
      this.budgets.set(deviceId, budget);
    }
    return budget;
  }
}

function clearPending(budget: Budget): void {
  if (budget.timer) clearTimeout(budget.timer);
  budget.timer = null;
}
