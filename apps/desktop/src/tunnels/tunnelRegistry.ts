/** DOM-free bookkeeping of the running tunnels: each device's tunnel, the
 * routing of `tunnel_status` events (keyed by tunnel id) back to it, and the
 * tunnels whose forward changes must wait. */

import type { DeviceTunnelState } from "./tunnelForwards";

export class TunnelRegistry {
  /** deviceId → its live tunnel state (present only while a tunnel runs). */
  private readonly byDevice = new Map<string, DeviceTunnelState>();
  private readonly deviceByTunnel = new Map<string, string>();
  /** Tunnels whose `startTunnel` hasn't returned: the backend may not know the
   * id yet, so forward changes wait and are reconciled once it has. */
  readonly starting = new Set<string>();
  /** Tunnels being stopped to restart with new connection settings: forward
   * changes wait, and the replacement starts once the old one let go of its
   * ports. */
  readonly restarting = new Set<string>();
  /** Dropped tunnels waiting to be reopened: forward changes wait for the
   * replacement, which carries whatever the user wants by then. */
  readonly waiting = new Set<string>();

  track(deviceId: string, state: DeviceTunnelState): void {
    this.deviceByTunnel.set(state.tunnelId, deviceId);
    this.byDevice.set(deviceId, state);
  }

  findDevice(tunnelId: string): string | undefined {
    return this.deviceByTunnel.get(tunnelId);
  }

  findState(deviceId: string): DeviceTunnelState | undefined {
    return this.byDevice.get(deviceId);
  }

  /** The device's state, if `tunnelId` is still its tunnel. */
  findCurrentState(deviceId: string, tunnelId: string): DeviceTunnelState | undefined {
    const state = this.byDevice.get(deviceId);
    return state?.tunnelId === tunnelId ? state : undefined;
  }

  /** The device's tunnel unless it is stopping (no forward wanted any more). */
  findActiveState(deviceId: string): DeviceTunnelState | undefined {
    const state = this.byDevice.get(deviceId);
    return state && state.requested.size > 0 ? state : undefined;
  }

  entries(): IterableIterator<[string, DeviceTunnelState]> {
    return this.byDevice.entries();
  }

  /** Drop an ended tunnel — but not a newer one started for the same device. */
  forget(deviceId: string, tunnelId: string): void {
    this.deviceByTunnel.delete(tunnelId);
    if (this.findCurrentState(deviceId, tunnelId)) this.byDevice.delete(deviceId);
  }

  unroute(tunnelId: string): void {
    this.deviceByTunnel.delete(tunnelId);
  }

  isDeferred(tunnelId: string): boolean {
    return this.starting.has(tunnelId) || this.restarting.has(tunnelId) || this.waiting.has(tunnelId);
  }
}
