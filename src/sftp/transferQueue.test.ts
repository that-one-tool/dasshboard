import { describe, it, expect, vi } from "vitest";
import { TransferQueue, type TransferItem } from "./transferQueue";
import type { AppError } from "../ipc";

/** A promise plus its resolve/reject, so a test can control when a `run` ends. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function hooks(overrides: Partial<Parameters<typeof makeQueue>[0]> = {}) {
  return {
    cancelActive: vi.fn(),
    onChange: vi.fn(),
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  };
}

function makeQueue(h: {
  cancelActive: (id: string) => void;
  onChange: () => void;
  onProgress: (item: TransferItem) => void;
  onComplete: (item: TransferItem, ctx: { successToast?: string; refreshDir?: string }) => void;
}) {
  return new TransferQueue(h);
}

describe("TransferQueue", () => {
  it("runs enqueued items sequentially, one active at a time", async () => {
    const h = hooks();
    const q = makeQueue(h);
    const a = deferred();
    const b = deferred();
    const order: string[] = [];

    q.enqueue({
      deviceId: "d",
      direction: "download",
      isDir: false,
      name: "a",
      run: () => {
        order.push("a-start");
        return a.promise;
      },
    });
    q.enqueue({
      deviceId: "d",
      direction: "download",
      isDir: false,
      name: "b",
      run: () => {
        order.push("b-start");
        return b.promise;
      },
    });
    await flush();

    // Only the first item is active; the second waits.
    expect(order).toEqual(["a-start"]);
    expect(q.items().map((i) => i.state)).toEqual(["active", "queued"]);

    a.resolve(undefined);
    await flush();
    expect(order).toEqual(["a-start", "b-start"]);
    expect(q.items().map((i) => i.state)).toEqual(["done", "active"]);

    b.resolve(undefined);
    await flush();
    expect(q.items().map((i) => i.state)).toEqual(["done", "done"]);
  });

  it("routes progress to the active item only", async () => {
    const h = hooks();
    const q = makeQueue(h);
    const d = deferred();
    q.enqueue({ deviceId: "d", direction: "download", isDir: false, name: "a", run: () => d.promise });
    await flush();

    q.applyProgress("d", 25, 100);
    expect(q.items()[0]?.transferred).toBe(25);
    expect(q.items()[0]?.total).toBe(100);

    // A tick for a device with no active item is ignored.
    q.applyProgress("other", 999, 1000);
    expect(q.items()[0]?.transferred).toBe(25);

    d.resolve(undefined);
    await flush();
  });

  it("cancelling a queued item marks it cancelled and never runs it", async () => {
    const h = hooks();
    const q = makeQueue(h);
    const a = deferred();
    const secondRun = vi.fn(() => Promise.resolve());
    q.enqueue({ deviceId: "d", direction: "download", isDir: false, name: "a", run: () => a.promise });
    const secondId = q.enqueue({
      deviceId: "d",
      direction: "download",
      isDir: false,
      name: "b",
      run: secondRun,
    });
    await flush();

    q.cancel(secondId); // still queued
    expect(q.items()[1]?.state).toBe("cancelled");

    a.resolve(undefined);
    await flush();
    // The cancelled item never executed.
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("cancelling an active item asks the backend, and its rejection is recorded", async () => {
    const h = hooks();
    const q = makeQueue(h);
    const d = deferred();
    const id = q.enqueue({
      deviceId: "dev",
      direction: "upload",
      isDir: false,
      name: "a",
      run: () => d.promise,
    });
    await flush();

    q.cancel(id);
    expect(h.cancelActive).toHaveBeenCalledWith("dev");

    // The backend cancel surfaces as a Cancelled rejection from `run`.
    d.reject({ code: "Cancelled", message: "cancelled" } satisfies AppError);
    await flush();
    expect(q.items()[0]?.state).toBe("cancelled");
  });

  it("a rejected run (non-cancel) becomes a failed item carrying the error", async () => {
    const h = hooks();
    const q = makeQueue(h);
    const err: AppError = { code: "Sftp", message: "boom" };
    q.enqueue({
      deviceId: "d",
      direction: "download",
      isDir: false,
      name: "a",
      run: () => Promise.reject(err),
    });
    await flush();
    const item = q.items()[0];
    expect(item?.state).toBe("failed");
    expect(item?.error).toBe(err);
  });

  it("onComplete fires once per item with its toast + refreshDir context", async () => {
    const completions: { name: string; state: string; toast?: string; dir?: string }[] = [];
    const h = hooks({
      onComplete: (item, ctx) =>
        completions.push({
          name: item.name,
          state: item.state,
          toast: ctx.successToast,
          dir: ctx.refreshDir,
        }),
    });
    const q = makeQueue(h);
    q.enqueue({
      deviceId: "d",
      direction: "upload",
      isDir: false,
      name: "up",
      run: () => Promise.resolve(),
      successToast: "Uploaded up",
      refreshDir: "/home",
    });
    await flush();
    expect(completions).toEqual([{ name: "up", state: "done", toast: "Uploaded up", dir: "/home" }]);
  });

  it("cancelDevice drops a device's items and cancels its active transfer", async () => {
    const h = hooks();
    const q = makeQueue(h);
    const d = deferred();
    q.enqueue({ deviceId: "d1", direction: "download", isDir: false, name: "a", run: () => d.promise });
    q.enqueue({ deviceId: "d1", direction: "download", isDir: false, name: "b", run: () => Promise.resolve() });
    q.enqueue({ deviceId: "d2", direction: "download", isDir: false, name: "c", run: () => Promise.resolve() });
    await flush();

    q.cancelDevice("d1");
    expect(h.cancelActive).toHaveBeenCalledWith("d1");
    // Only d2's item survives; its (later) rejection of the dropped active item
    // must not resurrect it.
    expect(q.items().map((i) => i.deviceId)).toEqual(["d2"]);

    d.reject({ code: "Cancelled", message: "x" } satisfies AppError);
    await flush();
    expect(q.items().map((i) => i.deviceId)).toEqual(["d2"]);
  });

  it("clearFinished removes terminal items but keeps live ones", async () => {
    const h = hooks();
    const q = makeQueue(h);
    const live = deferred();
    q.enqueue({ deviceId: "d", direction: "download", isDir: false, name: "done", run: () => Promise.resolve() });
    await flush(); // first completes
    q.enqueue({ deviceId: "d", direction: "download", isDir: false, name: "live", run: () => live.promise });
    await flush(); // second active

    expect(q.items().map((i) => i.state)).toEqual(["done", "active"]);
    q.clearFinished();
    expect(q.items().map((i) => i.name)).toEqual(["live"]);

    live.resolve(undefined);
    await flush();
  });
});
