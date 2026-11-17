import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputQueue, type InputHealth } from "./inputQueue";

/** A send answered by hand, recording when it started. */
function deferredSend(log: string[], name: string) {
  let resolve = (): void => {};
  let reject = (): void => {};
  const send = (): Promise<void> => {
    log.push(`start ${name}`);
    return new Promise<void>((ok, fail) => {
      resolve = () => {
        log.push(`end ${name}`);
        ok();
      };
      reject = () => fail(new Error("ipc failed"));
    });
  };
  return { send, finish: () => resolve(), fail: () => reject() };
}

/** A send that records its name and succeeds at once. */
function quickSend(log: string[], name: string): () => Promise<void> {
  return async () => {
    log.push(`sent ${name}`);
  };
}

const TIMEOUT_MS = 50;
const LOST_AFTER_MS = 150;

describe("InputQueue", () => {
  let log: string[];
  let stalls: InputHealth[];
  let queue: InputQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    log = [];
    stalls = [];
    queue = new InputQueue((health) => stalls.push(health), {
      stalledAfterMs: TIMEOUT_MS,
      lostAfterMs: LOST_AFTER_MS,
    });
  });
  afterEach(() => vi.useRealTimers());

  it("starts a send only once the one before it finished", async () => {
    const first = deferredSend(log, "a");
    const second = deferredSend(log, "b");

    queue.push(first.send);
    queue.push(second.send);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(["start a"]);

    first.finish();
    await vi.advanceTimersByTimeAsync(0);
    second.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
    expect(stalls).toEqual([]);
  });

  it("stalls on a send that takes too long, holding keys typed meanwhile", async () => {
    const slow = deferredSend(log, "a");
    queue.push(slow.send);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(stalls).toEqual(["stalled"]);

    queue.push(quickSend(log, "typed while stalled"));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(log).toEqual(["start a"]);
  });

  it("delivers every key typed while stalled, in order, once the late send answers", async () => {
    const slow = deferredSend(log, "a");
    queue.push(slow.send);
    queue.push(quickSend(log, "b"));
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS - 1);
    queue.push(quickSend(log, "c"));

    slow.finish();
    await vi.advanceTimersByTimeAsync(0);
    queue.push(quickSend(log, "d"));
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual(["start a", "end a", "sent b", "sent c", "sent d"]);
    expect(stalls).toEqual(["stalled", "ok"]);
  });

  it("stops sending for good after a failed send, dropping queued and later keys", async () => {
    const failing = deferredSend(log, "a");
    queue.push(failing.send);
    queue.push(quickSend(log, "b"));

    failing.fail();
    await vi.advanceTimersByTimeAsync(0);
    queue.push(quickSend(log, "c"));
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);

    expect(log).toEqual(["start a"]);
    expect(stalls).toEqual(["lost"]);
  });

  it("stops sending for good when a send stays unanswered too long", async () => {
    const slow = deferredSend(log, "a");
    queue.push(slow.send);
    queue.push(quickSend(log, "b"));
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);
    expect(stalls).toEqual(["stalled", "lost"]);

    slow.finish();
    queue.push(quickSend(log, "c"));
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toEqual(["start a", "end a"]);
    expect(stalls).toEqual(["stalled", "lost"]);
  });

  it("stays lost when the send that timed out fails afterwards", async () => {
    const slow = deferredSend(log, "a");
    queue.push(slow.send);
    await vi.advanceTimersByTimeAsync(LOST_AFTER_MS);

    slow.fail();
    await vi.advanceTimersByTimeAsync(0);

    expect(stalls).toEqual(["stalled", "lost"]);
  });

  it("leaves no timer behind after a quick send", async () => {
    queue.push(quickSend(log, "a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
