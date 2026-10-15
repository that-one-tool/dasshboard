import { describe, it, expect, vi } from "vitest";
import { reloadConfigAll, refreshDevicesAll, retranslateAll, type LiveView } from "./liveViews";

describe("refreshDevicesAll", () => {
  it("refreshes every view that shows devices", async () => {
    const grids = { refreshDevices: vi.fn(async () => {}) };
    const settings = { reloadConfig: vi.fn(async () => {}) };
    await refreshDevicesAll([grids, settings]);
    expect(grids.refreshDevices).toHaveBeenCalledOnce();
    expect(settings.reloadConfig).not.toHaveBeenCalled();
  });
});

describe("reloadConfigAll", () => {
  it("reloads each view, falling back to its device refresh", async () => {
    const deviceList = { reloadConfig: vi.fn(async () => {}), refreshDevices: vi.fn() };
    const profiles = { refreshDevices: vi.fn(async () => {}) };
    await reloadConfigAll([deviceList, profiles, { retranslate: vi.fn() }]);
    expect(deviceList.reloadConfig).toHaveBeenCalledOnce();
    expect(deviceList.refreshDevices).not.toHaveBeenCalled();
    expect(profiles.refreshDevices).toHaveBeenCalledOnce();
  });

  it("one view failing doesn't stop the others", async () => {
    const after = { reloadConfig: vi.fn(async () => {}) };
    const views: LiveView[] = [{ reloadConfig: () => Promise.reject(new Error("ipc")) }, after];
    await expect(reloadConfigAll(views)).resolves.toBeUndefined();
    expect(after.reloadConfig).toHaveBeenCalledOnce();
  });

  it("a view that throws right away doesn't stop the others either", async () => {
    const after = { refreshDevices: vi.fn() };
    const failing: LiveView = {
      refreshDevices: () => {
        throw new Error("sync");
      },
    };
    await expect(reloadConfigAll([failing, after])).resolves.toBeUndefined();
    expect(after.refreshDevices).toHaveBeenCalledOnce();
  });
});

describe("retranslateAll", () => {
  it("retranslates the views in order", () => {
    const order: string[] = [];
    retranslateAll([
      { retranslate: () => order.push("first") },
      { refreshDevices: vi.fn() },
      { retranslate: () => order.push("second") },
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});
