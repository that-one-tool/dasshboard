import { describe, it, expect, beforeEach } from "vitest";
import type { DeviceTunnelState } from "./tunnelForwards";
import { TunnelRegistry } from "./tunnelRegistry";

function tunnel(tunnelId: string, requested: string[] = ["f1"]): DeviceTunnelState {
  return { tunnelId, status: "connecting", requested: new Set(requested), forwards: [] };
}

describe("TunnelRegistry", () => {
  let registry: TunnelRegistry;

  beforeEach(() => {
    registry = new TunnelRegistry();
  });

  it("routes a tunnel's events to its device", () => {
    registry.track("d1", tunnel("t1"));
    expect(registry.findDevice("t1")).toBe("d1");
    expect(registry.findState("d1")?.tunnelId).toBe("t1");
    expect([...registry.entries()].map(([deviceId]) => deviceId)).toEqual(["d1"]);
  });

  it("finds a device's state only for its current tunnel", () => {
    registry.track("d1", tunnel("t1"));
    registry.track("d1", tunnel("t2"));
    expect(registry.findCurrentState("d1", "t2")?.tunnelId).toBe("t2");
    expect(registry.findCurrentState("d1", "t1")).toBeUndefined();
    expect(registry.findCurrentState("d2", "t2")).toBeUndefined();
  });

  it("an active tunnel still has forwards wanted", () => {
    registry.track("d1", tunnel("t1", []));
    expect(registry.findActiveState("d1")).toBeUndefined();
    registry.track("d1", tunnel("t2"));
    expect(registry.findActiveState("d1")?.tunnelId).toBe("t2");
  });

  it("forgets an ended tunnel, but not a newer one for the same device", () => {
    registry.track("d1", tunnel("t1"));
    registry.track("d1", tunnel("t2"));
    registry.forget("d1", "t1");
    expect(registry.findDevice("t1")).toBeUndefined();
    expect(registry.findState("d1")?.tunnelId).toBe("t2");
    registry.forget("d1", "t2");
    expect(registry.findState("d1")).toBeUndefined();
  });

  it("unroute stops a tunnel's events reaching its device, keeping its state", () => {
    registry.track("d1", tunnel("t1"));
    registry.unroute("t1");
    expect(registry.findDevice("t1")).toBeUndefined();
    expect(registry.findState("d1")?.tunnelId).toBe("t1");
  });

  it("defers forward changes while a tunnel starts, restarts or waits to reconnect", () => {
    expect(registry.isDeferred("t1")).toBe(false);
    for (const set of [registry.starting, registry.restarting, registry.waiting]) {
      set.add("t1");
      expect(registry.isDeferred("t1")).toBe(true);
      set.delete("t1");
    }
    expect(registry.isDeferred("t1")).toBe(false);
  });
});
