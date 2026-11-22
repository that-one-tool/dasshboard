import { describe, it, expect, vi } from "vitest";
import { reloadConfigAll, retranslateAll, type LiveView } from "./liveViews";

describe("reloadConfigAll", () => {
  it("reloads each view that reloads config", async () => {
    const deviceList = { reloadConfig: vi.fn(async () => {}) };
    const settings = { reloadConfig: vi.fn(async () => {}) };
    await reloadConfigAll([deviceList, { retranslate: vi.fn() }, settings]);
    expect(deviceList.reloadConfig).toHaveBeenCalledOnce();
    expect(settings.reloadConfig).toHaveBeenCalledOnce();
  });

  it("one view failing doesn't stop the others", async () => {
    const after = { reloadConfig: vi.fn(async () => {}) };
    const views: LiveView[] = [{ reloadConfig: () => Promise.reject(new Error("ipc")) }, after];
    await expect(reloadConfigAll(views)).resolves.toBeUndefined();
    expect(after.reloadConfig).toHaveBeenCalledOnce();
  });

  it("a view that throws right away doesn't stop the others either", async () => {
    const after = { reloadConfig: vi.fn() };
    const failing: LiveView = {
      reloadConfig: () => {
        throw new Error("sync");
      },
    };
    await expect(reloadConfigAll([failing, after])).resolves.toBeUndefined();
    expect(after.reloadConfig).toHaveBeenCalledOnce();
  });
});

describe("retranslateAll", () => {
  it("retranslates the views in order", () => {
    const order: string[] = [];
    retranslateAll([
      { retranslate: () => order.push("first") },
      { reloadConfig: vi.fn() },
      { retranslate: () => order.push("second") },
    ]);
    expect(order).toEqual(["first", "second"]);
  });
});
