/** What the tunnel supervisor needs from the backend: devices, tunnel
 * commands, `tunnel_status` events, and new tunnel ids. `ipcTunnelsPort` is
 * the real one; tests use `FakeTunnelsPort` (`fakeTunnelsPort.testing.ts`). */

import {
  listDevices,
  listTunnels,
  onTunnelStatus,
  startTunnel,
  startTunnelForward,
  stopTunnel,
  stopTunnelForward,
  type Device,
  type TunnelInfo,
  type TunnelStatusEvent,
} from "../ipc";

export interface TunnelsPort {
  /** The frontend picks the id, so status events (which can beat the start
   * command's return) route to the device, and Stop works mid-start. */
  newTunnelId(): string;
  listDevices(): Promise<Device[]>;
  listTunnels(): Promise<TunnelInfo[]>;
  startTunnel(deviceId: string, tunnelId: string, forwardIds: string[]): Promise<string>;
  stopTunnel(tunnelId: string): Promise<void>;
  startTunnelForward(tunnelId: string, forwardId: string): Promise<void>;
  stopTunnelForward(tunnelId: string, forwardId: string): Promise<void>;
  onTunnelStatus(handler: (event: TunnelStatusEvent) => void): Promise<() => void>;
}

export const ipcTunnelsPort: TunnelsPort = {
  newTunnelId: () => crypto.randomUUID(),
  listDevices,
  listTunnels,
  startTunnel,
  stopTunnel,
  startTunnelForward,
  stopTunnelForward,
  onTunnelStatus,
};
