import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DebouncedWrite } from "./debouncedWrite";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("DebouncedWrite", () => {
  it("writes once after the delay, however often it was scheduled", () => {
    const write = vi.fn();
    const saver = new DebouncedWrite(write, 500);
    saver.schedule();
    vi.advanceTimersByTime(400);
    saver.schedule();
    vi.advanceTimersByTime(400);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending write at once, and only once", () => {
    const write = vi.fn();
    const saver = new DebouncedWrite(write, 500);
    saver.schedule();
    saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does nothing on flush with no pending write", () => {
    const write = vi.fn();
    const saver = new DebouncedWrite(write, 500);
    saver.flush();
    saver.schedule();
    vi.advanceTimersByTime(500);
    saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
