import { describe, it, expect } from "vitest";
import {
  MAX_RECONNECT_ATTEMPTS,
  canReconnect,
  countKeyringFailure,
  errorCodeOf,
  isRetryableFailure,
  reconnectDelayMs,
} from "./reconnect";

describe("isRetryableFailure", () => {
  it("retries a plain drop and a failure to reach or keep the server", () => {
    for (const code of [undefined, "SshConnect", "SshChannel", "Io"] as const) {
      expect(isRetryableFailure(code), String(code)).toBe(true);
    }
  });
  it("never retries what a retry would only repeat (lockouts, re-prompts)", () => {
    for (const code of ["SshAuth", "HostKeyRejected", "Validation", "NotFound", "TunnelBind"] as const) {
      expect(isRetryableFailure(code), code).toBe(false);
    }
  });
});

describe("keychain failures", () => {
  it("retries a keychain failure once (locked or not ready yet), then gives up", () => {
    const first = countKeyringFailure("Keyring", 0);
    expect(isRetryableFailure("Keyring", first)).toBe(true);
    const second = countKeyringFailure("Keyring", first);
    expect(isRetryableFailure("Keyring", second)).toBe(false);
  });
  it("counts only keychain failures", () => {
    expect(countKeyringFailure("SshConnect", 1)).toBe(1);
    expect(countKeyringFailure(undefined, 0)).toBe(0);
  });
});

describe("errorCodeOf", () => {
  it("reads an AppError's code, or nothing for anything else", () => {
    expect(errorCodeOf({ code: "SshAuth", message: "x" })).toBe("SshAuth");
    expect(errorCodeOf(new Error("boom"))).toBeUndefined();
    expect(errorCodeOf("boom")).toBeUndefined();
  });
});

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
