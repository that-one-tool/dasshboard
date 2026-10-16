import { describe, it, expect } from "vitest";
import { DeviceCallQueue } from "./deviceCallQueue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("DeviceCallQueue", () => {
  it("runs a device's calls one at a time, in order", async () => {
    const queue = new DeviceCallQueue();
    const log: string[] = [];
    const first = deferred();
    void queue.enqueue("d1", async () => {
      log.push("first start");
      await first.promise;
      log.push("first end");
    });
    const second = queue.enqueue("d1", async () => {
      log.push("second");
    });
    await Promise.resolve();
    expect(log).toEqual(["first start"]);
    first.resolve();
    await second;
    expect(log).toEqual(["first start", "first end", "second"]);
  });

  it("does not hold one device's calls behind another's", async () => {
    const queue = new DeviceCallQueue();
    const blocked = deferred();
    void queue.enqueue("d1", () => blocked.promise);
    let ran = false;
    await queue.enqueue("d2", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    blocked.resolve();
  });

  it("resolves each call's promise once that call is done", async () => {
    const queue = new DeviceCallQueue();
    let done = false;
    await queue.enqueue("d1", async () => {
      done = true;
    });
    expect(done).toBe(true);
  });
});
