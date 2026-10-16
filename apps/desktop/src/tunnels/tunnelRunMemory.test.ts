import { describe, it, expect, vi } from "vitest";
import type { SshDevice } from "../ipc";
import { TunnelRunMemory } from "./tunnelRunMemory";

const device = (id: string) => ({ id }) as SshDevice;

describe("TunnelRunMemory", () => {
  it("starts from the restored state", () => {
    const memory = new TunnelRunMemory({ d1: ["f1"] });
    expect(memory.choiceFor("d1")).toEqual(["f1"]);
    expect(memory.choiceFor("d2")).toBeUndefined();
  });

  it("remembers a choice and asks for a save", () => {
    const onPersist = vi.fn();
    const memory = new TunnelRunMemory(undefined, onPersist);
    memory.remember("d1", false);
    expect(memory.choiceFor("d1")).toBe(false);
    expect(onPersist).toHaveBeenCalledOnce();
  });

  it("needs no save callback", () => {
    const memory = new TunnelRunMemory(undefined);
    memory.remember("d1", ["f1"]);
    expect(memory.choiceFor("d1")).toEqual(["f1"]);
  });

  it("hands back the restored state untouched until the devices loaded", () => {
    const restored = { d1: ["f1"], gone: true };
    const memory = new TunnelRunMemory(restored);
    expect(memory.stateFor([])).toBe(restored);
  });

  it("once loaded, keeps only devices that can still tunnel", () => {
    const memory = new TunnelRunMemory({ d1: ["f1"], gone: true });
    memory.markLoaded();
    expect(memory.stateFor([device("d1")])).toEqual({ d1: ["f1"] });
  });

  it("has nothing to save when nothing is remembered", () => {
    const memory = new TunnelRunMemory({ gone: true });
    memory.markLoaded();
    expect(memory.stateFor([device("d1")])).toBeUndefined();
  });
});
