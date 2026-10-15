import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReconnectBudget } from "./reconnectBudget";
import { MAX_RECONNECT_ATTEMPTS } from "./reconnect";

describe("ReconnectBudget", () => {
  let retry: ReturnType<typeof vi.fn<() => void>>;
  let budget: ReconnectBudget;

  beforeEach(() => {
    vi.useFakeTimers();
    retry = vi.fn<() => void>();
    budget = new ReconnectBudget(retry);
  });
  afterEach(() => vi.useRealTimers());

  it("retries after the backoff (2 s, then 4 s), counting attempts", () => {
    expect(budget.schedule(true, "SshConnect")).toBe(true);
    expect(budget.attempts).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledOnce();

    budget.schedule(true);
    expect(budget.attempts).toBe(2);
    vi.advanceTimersByTime(3999);
    expect(retry).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("is in progress from the first scheduled attempt until reset", () => {
    expect(budget.isInProgress()).toBe(false);
    budget.schedule(true);
    vi.runAllTimers();
    expect(budget.isInProgress()).toBe(true);
    budget.reset();
    expect(budget.isInProgress()).toBe(false);
    expect(budget.attempts).toBe(0);
  });

  it("does nothing when auto-reconnect is off", () => {
    expect(budget.schedule(false)).toBe(false);
    vi.runAllTimers();
    expect(retry).not.toHaveBeenCalled();
  });

  it("never retries a failure a retry would only repeat", () => {
    expect(budget.schedule(true, "SshAuth")).toBe(false);
    expect(budget.schedule(true, "HostKeyRejected")).toBe(false);
  });

  it("allows one keychain failure per sequence, then gives up and starts afresh", () => {
    expect(budget.schedule(true, "Keyring")).toBe(true);
    expect(budget.schedule(true, "Keyring")).toBe(false);
    expect(budget.isInProgress()).toBe(false);
    expect(budget.schedule(true, "Keyring")).toBe(true);
  });

  it("gives up after the attempt budget, then starts afresh", () => {
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      expect(budget.schedule(true)).toBe(true);
      vi.runAllTimers();
    }
    expect(budget.schedule(true)).toBe(false);
    expect(budget.attempts).toBe(0);
    expect(budget.schedule(true)).toBe(true);
  });

  it("a second drop before the retry replaces it rather than adding one", () => {
    budget.schedule(true);
    budget.schedule(true);
    vi.runAllTimers();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("reset cancels a pending retry", () => {
    budget.schedule(true);
    budget.reset();
    vi.runAllTimers();
    expect(retry).not.toHaveBeenCalled();
  });
});
