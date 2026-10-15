import { describe, it, expect, vi } from "vitest";
import type { AppError } from "../../ipc";
import { getBulkOutcome, runEach } from "./bulkRun";

const failure = (message: string): AppError => ({ code: "Sftp", message });

describe("runEach", () => {
  it("runs the items one at a time, in order", async () => {
    const order: number[] = [];
    let running = 0;
    let mostAtOnce = 0;
    const result = await runEach([1, 2, 3], async (n) => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await Promise.resolve();
      order.push(n);
      running -= 1;
    });
    expect(mostAtOnce).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    expect(result).toEqual({ done: 3, firstError: null });
  });

  it("keeps going past a failure, counting the successes and keeping the first error", async () => {
    const run = vi.fn(async (n: number) => {
      if (n !== 2) throw failure(`no ${n}`);
    });
    const result = await runEach([1, 2, 3], run);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ done: 1, firstError: failure("no 1") });
  });
});

describe("getBulkOutcome", () => {
  it("is partial when something failed", () => {
    expect(getBulkOutcome({ done: 1, firstError: failure("x") })).toBe("partial");
    expect(getBulkOutcome({ done: 0, firstError: failure("x") })).toBe("partial");
  });

  it("is a success when something was done and nothing failed", () => {
    expect(getBulkOutcome({ done: 2, firstError: null })).toBe("success");
  });

  it("is nothing when there was nothing to do", () => {
    expect(getBulkOutcome({ done: 0, firstError: null })).toBe("nothing");
  });
});
