import { describe, it, expect, beforeEach } from "vitest";
import { SessionSlot } from "./sessionSlot";

describe("SessionSlot", () => {
  let slot: SessionSlot;

  beforeEach(() => {
    slot = new SessionSlot();
  });

  it("starts empty", () => {
    expect(slot.isBusy()).toBe(false);
    expect(slot.current).toBeNull();
    expect(slot.writableId()).toBeNull();
    expect(slot.resizableId()).toBeNull();
  });

  it("owns a session from the moment it is opened", () => {
    slot.open("s1");
    expect(slot.isOwnerOf("s1")).toBe(true);
    expect(slot.isOwnerOf("s2")).toBe(false);
    expect(slot.isBusy()).toBe(true);
    expect(slot.current).toBeNull();
  });

  it("adopts the session it is opening", () => {
    slot.open("s1");
    expect(slot.adopt("s1")).toBe(true);
    expect(slot.current).toBe("s1");
    expect(slot.isOwnerOf("s1")).toBe(true);
  });

  it("refuses a session it let go of while opening", () => {
    slot.open("s1");
    slot.release();
    expect(slot.adopt("s1")).toBe(false);
    expect(slot.current).toBeNull();
  });

  it("a failed open is reported only while still pending", () => {
    slot.open("s1");
    expect(slot.failOpen("s1")).toBe(true);
    expect(slot.isOwnerOf("s1")).toBe(false);
    expect(slot.failOpen("s1")).toBe(false);
  });

  it("writes only once connected and adopted", () => {
    slot.open("s1");
    slot.markConnected();
    expect(slot.writableId()).toBeNull();
    expect(slot.resizableId()).toBe("s1");
    slot.adopt("s1");
    expect(slot.writableId()).toBe("s1");
    expect(slot.isConnected()).toBe(true);
  });

  it("release returns every id it held and empties the slot", () => {
    slot.open("s1");
    slot.adopt("s1");
    slot.markConnected();
    slot.open("s2");
    expect(slot.release()).toEqual(["s1", "s2"]);
    expect(slot.isBusy()).toBe(false);
    expect(slot.isConnected()).toBe(false);
  });

  it("dropCurrent lets go of the open session only, keeping one still opening", () => {
    slot.open("s1");
    slot.adopt("s1");
    slot.markConnected();
    slot.open("s2");
    expect(slot.dropCurrent()).toBe("s1");
    expect(slot.current).toBeNull();
    expect(slot.isConnected()).toBe(false);
    expect(slot.isOwnerOf("s2")).toBe(true);
    expect(slot.dropCurrent()).toBeNull();
  });

  it("end forgets the session without listing it", () => {
    slot.open("s1");
    slot.adopt("s1");
    slot.markConnected();
    slot.end();
    expect(slot.isBusy()).toBe(false);
    expect(slot.writableId()).toBeNull();
  });
});
