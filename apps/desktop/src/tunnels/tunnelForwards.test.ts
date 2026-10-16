import { describe, it, expect } from "vitest";
import type { Device, Forward, ForwardStatus, SshDevice } from "../ipc";
import {
  copyTarget,
  forwardEndpoint,
  forwardIdsToRun,
  forwardState,
  isConnectionChanged,
  isForwardEdited,
  isJumpHostLost,
  listeningForwardCount,
  runChoiceOf,
  runningInOrder,
  statusLabel,
  tunnelableDevices,
} from "./tunnelForwards";

function sshDevice(id: string, name: string, forwards: Forward[] = []): Device {
  return {
    id,
    name,
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    auth: { method: "password" },
    forwards,
    tunnelAutoStart: false,
    autoReconnect: false,
  } as Device;
}

function forward(id: string, localPort: number): Forward {
  return {
    id,
    name: `fwd-${id}`,
    kind: "local",
    localAddr: "127.0.0.1",
    localPort,
    remoteHost: "db",
    remotePort: 5432,
  };
}

describe("pure helpers", () => {
  it("tunnelableDevices keeps only SSH devices with forwards", () => {
    const devices = [
      sshDevice("a", "A", [forward("f1", 5432)]),
      sshDevice("b", "B", []),
      { id: "s", name: "serial", kind: "serial" } as unknown as Device,
    ];
    const result = tunnelableDevices(devices);
    expect(result.map((d) => d.id)).toEqual(["a"]);
  });

  it("statusLabel maps every status", () => {
    expect(statusLabel("connecting")).toBe("Connecting…");
    expect(statusLabel("listening")).toBe("Listening");
    expect(statusLabel("error")).toBe("Error");
    expect(statusLabel("stopped")).toBe("Stopped");
    expect(statusLabel("disconnected")).toBe("Stopped");
  });

  it("forwardEndpoint formats local → remote", () => {
    expect(
      forwardEndpoint({
        kind: "local",
        localAddr: "127.0.0.1",
        localPort: 5432,
        remoteHost: "db",
        remotePort: 6543,
      }),
    ).toBe("127.0.0.1:5432 → db:6543");
  });

  it("forwardEndpoint shows a remote forward as local ← server", () => {
    expect(
      forwardEndpoint({
        kind: "remote",
        localAddr: "127.0.0.1",
        localPort: 3000,
        remoteHost: "localhost",
        remotePort: 8080,
      }),
    ).toBe("127.0.0.1:3000 ← localhost:8080");
  });

  it("copyTarget is the local end, or the server's for a remote forward", () => {
    expect(copyTarget(forward("f1", 5432))).toBe("127.0.0.1:5432");
    expect(copyTarget({ ...forward("f1", 3000), kind: "remote", remoteHost: "localhost", remotePort: 8080 })).toBe(
      "localhost:8080",
    );
  });

  it("forwardEndpoint shows a dynamic forward as a SOCKS proxy", () => {
    expect(
      forwardEndpoint({
        kind: "dynamic",
        localAddr: "127.0.0.1",
        localPort: 1080,
        remoteHost: "",
        remotePort: 0,
      }),
    ).toBe("127.0.0.1:1080 → SOCKS proxy");
  });
});

function bound(forwardId: string, isBound = true): ForwardStatus {
  return {
    forwardId,
    localAddr: "127.0.0.1",
    localPort: 5432,
    remoteHost: "db",
    remotePort: 5432,
    bound: isBound,
  };
}

describe("per-forward state helpers", () => {
  const live = {
    tunnelId: "t1",
    status: "listening" as const,
    requested: new Set(["f1", "f2", "f3"]),
    forwards: [bound("f1"), bound("f2", false)],
  };

  it("forwardState maps a forward to its dot color state", () => {
    expect(forwardState(undefined, "f1")).toBe("stopped");
    expect(forwardState(live, "f1")).toBe("listening");
    expect(forwardState(live, "f2")).toBe("unbound");
    expect(forwardState(live, "f3")).toBe("connecting"); // asked for, not reported yet
    expect(forwardState(live, "f4")).toBe("stopped"); // not asked for
  });

  it("listeningForwardCount counts only the bound forwards, across devices", () => {
    expect(listeningForwardCount([])).toBe(0);
    expect(listeningForwardCount([live, { ...live, requested: new Set(["f1"]) }])).toBe(2);
  });

  const device = sshDevice("dev-1", "NAS", [forward("f1", 1), forward("f2", 2)]) as SshDevice;

  it("forwardIdsToRun reads a remembered choice, else the auto-start flag", () => {
    expect(forwardIdsToRun(device, true)).toEqual(["f1", "f2"]);
    expect(forwardIdsToRun(device, false)).toEqual([]);
    expect(forwardIdsToRun(device, ["f2", "gone"])).toEqual(["f2"]);
    expect(forwardIdsToRun(device, undefined)).toEqual([]);
    expect(forwardIdsToRun({ ...device, tunnelAutoStart: true }, undefined)).toEqual(["f1", "f2"]);
  });

  it("runChoiceOf records all, none, or the listed forwards", () => {
    expect(runChoiceOf(device, new Set(["f2", "f1"]))).toEqual(["f1", "f2"]);
    expect(runChoiceOf(device, new Set())).toBe(false);
    expect(runChoiceOf(device, new Set(["f2"]))).toEqual(["f2"]);
  });
});

describe("edit detection", () => {
  const device = sshDevice("dev-1", "NAS", [forward("f1", 1), forward("f2", 2)]) as SshDevice;

  it("a changed host, port, user, auth or jump host changes the connection", () => {
    expect(isConnectionChanged(device, { ...device, name: "renamed" })).toBe(false);
    expect(isConnectionChanged(device, { ...device, host: "10.0.0.2" })).toBe(true);
    expect(isConnectionChanged(device, { ...device, port: 2222 })).toBe(true);
    expect(isConnectionChanged(device, { ...device, username: "root" })).toBe(true);
    expect(isConnectionChanged(device, { ...device, auth: { method: "agent" } } as SshDevice)).toBe(true);
    expect(isConnectionChanged(device, { ...device, proxyJump: "jump" })).toBe(true);
  });

  it("only removing the jump host loses it", () => {
    const jumped = { ...device, proxyJump: "jump" };
    expect(isJumpHostLost(jumped, device)).toBe(true);
    expect(isJumpHostLost(jumped, { ...jumped, proxyJump: "other" })).toBe(false);
    expect(isJumpHostLost(device, jumped)).toBe(false);
    expect(isJumpHostLost(device, device)).toBe(false);
  });

  it("a forward is edited when its listener settings changed, not its name", () => {
    const renamed = { ...device, forwards: [{ ...forward("f1", 1), name: "db" }, forward("f2", 2)] };
    const moved = { ...device, forwards: [forward("f1", 9), forward("f2", 2)] };
    expect(isForwardEdited(device, renamed, "f1")).toBe(false);
    expect(isForwardEdited(device, moved, "f1")).toBe(true);
    expect(isForwardEdited(device, moved, "f2")).toBe(false);
  });

  it("a forward missing on either side is not edited", () => {
    const without = { ...device, forwards: [forward("f2", 2)] };
    expect(isForwardEdited(device, without, "f1")).toBe(false);
    expect(isForwardEdited(without, device, "f1")).toBe(false);
  });

  it("runningInOrder lists the running forwards in the device's order", () => {
    expect(runningInOrder(device, new Set(["f2", "f1", "gone"]))).toEqual(["f1", "f2"]);
  });
});
