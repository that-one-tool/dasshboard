import { describe, it, expect, vi } from "vitest";

vi.mock("../ipc", () => ({
  listTunnels: vi.fn(async () => []),
  startTunnel: vi.fn(async (_deviceId: string, tunnelId: string) => tunnelId),
  stopTunnel: vi.fn(async () => {}),
  startTunnelForward: vi.fn(async () => {}),
  stopTunnelForward: vi.fn(async () => {}),
  onTunnelStatus: vi.fn(async () => () => {}),
}));

import {
  listTunnels,
  onTunnelStatus,
  startTunnel,
  startTunnelForward,
  stopTunnel,
  stopTunnelForward,
} from "../ipc";
import { ipcTunnelsPort } from "./tunnelsPort";

describe("ipcTunnelsPort", () => {
  it("passes each call to its IPC command", async () => {
    await ipcTunnelsPort.listTunnels();
    await ipcTunnelsPort.startTunnel("dev-1", "t1", ["f1"]);
    await ipcTunnelsPort.stopTunnel("t1");
    await ipcTunnelsPort.startTunnelForward("t1", "f2");
    await ipcTunnelsPort.stopTunnelForward("t1", "f2");
    const handler = vi.fn();
    await ipcTunnelsPort.onTunnelStatus(handler);

    expect(listTunnels).toHaveBeenCalled();
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1", ["f1"]);
    expect(stopTunnel).toHaveBeenCalledWith("t1");
    expect(startTunnelForward).toHaveBeenCalledWith("t1", "f2");
    expect(stopTunnelForward).toHaveBeenCalledWith("t1", "f2");
    expect(onTunnelStatus).toHaveBeenCalledWith(handler);
  });

  it("makes a fresh tunnel id each time", () => {
    expect(ipcTunnelsPort.newTunnelId()).not.toBe(ipcTunnelsPort.newTunnelId());
  });
});
