/** The user's last explicit Start/Stop per device, restored at launch and
 * saved with the workspace. */

import type { SshDevice } from "../ipc";
import type { TunnelRunChoice, TunnelRunState } from "./tunnelForwards";

export class TunnelRunMemory {
  private readonly remembered: Map<string, TunnelRunChoice>;
  /** False until the device list has loaded: pruning before that would drop
   * every remembered entry. */
  private loaded = false;

  constructor(
    private readonly restored: TunnelRunState | undefined,
    private readonly onPersist: () => void = () => {},
  ) {
    this.remembered = new Map(Object.entries(restored ?? {}));
  }

  choiceFor(deviceId: string): TunnelRunChoice | undefined {
    return this.remembered.get(deviceId);
  }

  remember(deviceId: string, choice: TunnelRunChoice): void {
    this.remembered.set(deviceId, choice);
    this.onPersist();
  }

  markLoaded(): void {
    this.loaded = true;
  }

  /** The state to save, limited to `tunnelable` devices; `undefined` when
   * there is nothing to remember. */
  stateFor(tunnelable: SshDevice[]): TunnelRunState | undefined {
    if (!this.loaded) return this.restored;
    const ids = new Set(tunnelable.map((d) => d.id));
    const kept = [...this.remembered].filter(([id]) => ids.has(id));
    return kept.length > 0 ? Object.fromEntries(kept) : undefined;
  }
}
