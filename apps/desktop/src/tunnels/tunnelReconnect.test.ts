import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TunnelReconnects } from "./tunnelReconnect";
import { MAX_RECONNECT_ATTEMPTS } from "../terminal/reconnect";

describe("TunnelReconnects", () => {
  let retry: ReturnType<typeof vi.fn<(deviceId: string) => void>>;
  let reconnects: TunnelReconnects;

  beforeEach(() => {
    vi.useFakeTimers();
    retry = vi.fn<(deviceId: string) => void>();
    reconnects = new TunnelReconnects(retry);
  });
  afterEach(() => vi.useRealTimers());

  it("retries a dropped tunnel after the panes' backoff (2 s, then 4 s)", () => {
    expect(reconnects.schedule("d1", true, "SshConnect")).toBe(true);
    vi.advanceTimersByTime(1999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledWith("d1");

    reconnects.schedule("d1", true, "SshConnect");
    vi.advanceTimersByTime(3999);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a device that did not opt in", () => {
    expect(reconnects.schedule("d1", false, "SshConnect")).toBe(false);
    vi.runAllTimers();
    expect(retry).not.toHaveBeenCalled();
  });

  it("never retries a failure a retry would only repeat", () => {
    expect(reconnects.schedule("d1", true, "SshAuth")).toBe(false);
    expect(reconnects.schedule("d1", true, "TunnelBind")).toBe(false);
  });

  it("gives up after the attempt budget, then starts afresh", () => {
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      expect(reconnects.schedule("d1", true)).toBe(true);
      vi.runAllTimers();
    }
    expect(reconnects.schedule("d1", true)).toBe(false);
    expect(reconnects.schedule("d1", true)).toBe(true);
  });

  it("a tunnel back up gets a full budget for its next drop", () => {
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      reconnects.schedule("d1", true);
      vi.runAllTimers();
    }
    reconnects.reset("d1");
    expect(reconnects.schedule("d1", true)).toBe(true);
  });

  it("a reset cancels a pending retry", () => {
    reconnects.schedule("d1", true);
    reconnects.reset("d1");
    vi.runAllTimers();
    expect(retry).not.toHaveBeenCalled();
  });

  it("a second drop before the retry replaces it rather than adding one", () => {
    reconnects.schedule("d1", true);
    reconnects.schedule("d1", true);
    vi.runAllTimers();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels every pending retry", () => {
    reconnects.schedule("d1", true);
    reconnects.schedule("d2", true);
    reconnects.dispose();
    vi.runAllTimers();
    expect(retry).not.toHaveBeenCalled();
  });

  it("keeps each device's budget apart", () => {
    reconnects.schedule("d1", true);
    reconnects.schedule("d2", true);
    vi.runAllTimers();
    expect(retry.mock.calls).toEqual([["d1"], ["d2"]]);
  });
});
