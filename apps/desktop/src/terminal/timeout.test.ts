import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "./timeout";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("settles with the promise when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100)).resolves.toBe("ok");
    await expect(withTimeout(Promise.reject(new Error("no")), 100)).rejects.toThrow("no");
  });

  it("rejects with a TimeoutError once the time is up", async () => {
    const never = new Promise<string>(() => {});
    const raced = withTimeout(never, 100);
    const outcome = expect(raced).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await outcome;
  });

  it("leaves no timer behind after the promise settled", async () => {
    await withTimeout(Promise.resolve(1), 100);
    expect(vi.getTimerCount()).toBe(0);
  });
});
