import { describe, it, expect } from "vitest";
import { MAX_RECONNECT_ATTEMPTS, canReconnect, reconnectDelayMs } from "./reconnect";

describe("reconnectDelayMs", () => {
  it("follows 2s / 4s / 8s then caps at 8s", () => {
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(3)).toBe(8000);
    expect(reconnectDelayMs(4)).toBe(8000);
    expect(reconnectDelayMs(5)).toBe(8000);
  });
  it("is safe for a zero/negative attempt", () => {
    expect(reconnectDelayMs(0)).toBe(2000);
  });
});

describe("canReconnect", () => {
  it("is false when the device opted out", () => {
    expect(canReconnect(false, 0)).toBe(false);
  });
  it("allows attempts up to the max, then stops", () => {
    expect(canReconnect(true, 0)).toBe(true);
    expect(canReconnect(true, MAX_RECONNECT_ATTEMPTS - 1)).toBe(true);
    expect(canReconnect(true, MAX_RECONNECT_ATTEMPTS)).toBe(false);
  });
});
