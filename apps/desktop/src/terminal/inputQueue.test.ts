import { describe, expect, it } from "vitest";
import { SerialQueue } from "./inputQueue";

/** A send that resolves when the test says so, recording when it started. */
function deferredSend(log: string[], name: string): { send: () => Promise<void>; finish: () => void } {
  let finish = (): void => {};
  const send = (): Promise<void> => {
    log.push(`start ${name}`);
    return new Promise<void>((resolve) => {
      finish = () => {
        log.push(`end ${name}`);
        resolve();
      };
    });
  };
  return { send, finish: () => finish() };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("SerialQueue", () => {
  it("starts a send only once the one before it finished", async () => {
    const log: string[] = [];
    const queue = new SerialQueue();
    const first = deferredSend(log, "a");
    const second = deferredSend(log, "b");

    queue.push(first.send);
    queue.push(second.send);
    await flush();
    expect(log).toEqual(["start a"]);

    first.finish();
    await flush();
    second.finish();
    await flush();
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("keeps going after a failed send", async () => {
    const sent: string[] = [];
    const queue = new SerialQueue();

    queue.push(() => Promise.reject(new Error("closed")));
    queue.push(async () => {
      sent.push("next");
    });
    await flush();

    expect(sent).toEqual(["next"]);
  });
});
