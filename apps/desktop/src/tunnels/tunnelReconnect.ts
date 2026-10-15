/**
 * Auto-reconnect for tunnels, per device, with the terminal panes' policy
 * (`terminal/reconnectBudget.ts`). DOM-free; the Tunnels panel decides when a
 * tunnel ended unexpectedly and what a retry starts.
 */

import type { ErrorCode } from "../ipc";
import { ReconnectBudget } from "../terminal/reconnectBudget";

export class TunnelReconnects {
  private readonly budgets = new Map<string, ReconnectBudget>();

  constructor(private readonly retry: (deviceId: string) => void) {}

  /** A device's tunnel ended unexpectedly (`code`: its error, if any). Schedules
   * a retry and returns `true`, or returns `false` (and starts the next drop
   * from a full budget) when it should stay down. */
  schedule(deviceId: string, autoReconnect: boolean, code?: ErrorCode): boolean {
    const scheduled = this.budgetOf(deviceId).schedule(autoReconnect, code);
    if (!scheduled) this.budgets.delete(deviceId);
    return scheduled;
  }

  /** The tunnel is back up, or the user took over: cancel any pending retry
   * and give its next drop a full budget. */
  reset(deviceId: string): void {
    this.budgets.get(deviceId)?.reset();
    this.budgets.delete(deviceId);
  }

  /** Cancel every pending retry (the panel is going away). */
  dispose(): void {
    for (const budget of this.budgets.values()) budget.reset();
    this.budgets.clear();
  }

  private budgetOf(deviceId: string): ReconnectBudget {
    let budget = this.budgets.get(deviceId);
    if (!budget) {
      budget = new ReconnectBudget(() => this.retry(deviceId));
      this.budgets.set(deviceId, budget);
    }
    return budget;
  }
}
