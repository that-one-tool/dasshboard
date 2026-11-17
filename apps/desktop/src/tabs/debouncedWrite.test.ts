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

  /** A write answered by hand, counting how often it started. */
  function heldWrite() {
    const finishes: Array<() => void> = [];
    const write = vi.fn(() => new Promise<void>((resolve) => finishes.push(resolve)));
    return { write, finish: () => finishes.shift()?.() };
  }

  it("starts no scheduled write while one is in flight, then writes once for all requests meanwhile", async () => {
    const { write, finish } = heldWrite();
    const saver = new DebouncedWrite(write, 500);
    saver.schedule();
    vi.advanceTimersByTime(500);
    saver.schedule();
    vi.advanceTimersByTime(500);
    saver.schedule();
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("flushes the latest state at once even while a write is in flight", () => {
    const { write } = heldWrite();
    const saver = new DebouncedWrite(write, 500);
    saver.schedule();
    vi.advanceTimersByTime(500);
    saver.schedule();

    saver.flush();

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("flushes a write waiting for the one in flight", () => {
    const { write } = heldWrite();
    const saver = new DebouncedWrite(write, 500);
    saver.schedule();
    vi.advanceTimersByTime(500);
    saver.schedule();
    vi.advanceTimersByTime(500);

    saver.flush();

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("writes once more after both settle, so the latest state lands last whatever order they commit in", async () => {
    const { write, finish } = heldWrite();
    const saver = new DebouncedWrite(write, 500);
    saver.schedule();
    vi.advanceTimersByTime(500);
    saver.schedule();
    saver.flush();

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(3);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("writes again after a failed write", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const saver = new DebouncedWrite(write, 500);
    saver.schedule();
    saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    saver.schedule();
    saver.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
