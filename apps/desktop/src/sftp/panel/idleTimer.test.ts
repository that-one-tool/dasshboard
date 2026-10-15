import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IdleTimer } from "./idleTimer";

describe("IdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once after the given minutes", () => {
    const onTimeout = vi.fn();
    new IdleTimer(onTimeout).arm(2);
    vi.advanceTimersByTime(2 * 60_000 - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("is off for zero minutes", () => {
    const onTimeout = vi.fn();
    new IdleTimer(onTimeout).arm(0);
    vi.runAllTimers();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("re-arming restarts the countdown", () => {
    const onTimeout = vi.fn();
    const timer = new IdleTimer(onTimeout);
    timer.arm(1);
    vi.advanceTimersByTime(50_000);
    timer.arm(1);
    vi.advanceTimersByTime(50_000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("never fires once cleared", () => {
    const onTimeout = vi.fn();
    const timer = new IdleTimer(onTimeout);
    timer.arm(1);
    timer.clear();
    vi.runAllTimers();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
