import { afterEach, describe, it, expect, vi } from "vitest";
import type { OutputChunk } from "../ipc";
import { OutputReader } from "./outputReader";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const chunk = (start: number, s: string, end = false): OutputChunk => ({ start, bytes: text(s), end });

/** A reader over scripted `read` replies, recording what reached the terminal. */
function scripted(replies: Array<OutputChunk | Error>) {
  const written: string[] = [];
  const read = vi.fn(async (_from: number) => {
    const reply = replies.shift();
    if (reply === undefined) return new Promise<OutputChunk>(() => {});
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const write = vi.fn(async (bytes: Uint8Array) => {
    written.push(new TextDecoder().decode(bytes));
  });
  const reader = new OutputReader({ read, write, retryDelayMs: 0 });
  return { reader, read, write, written };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("OutputReader", () => {
  afterEach(() => vi.useRealTimers());

  it("writes the output in order, each read starting where the last ended", async () => {
    const { reader, read, written } = scripted([chunk(0, "abc"), chunk(3, "de"), chunk(5, "", true)]);
    await reader.run();
    expect(written).toEqual(["abc", "de"]);
    expect(read.mock.calls.map(([from]) => from)).toEqual([0, 3, 5]);
  });

  it("an empty read (nothing yet) just reads again", async () => {
    const { reader, read, write } = scripted([chunk(0, ""), chunk(0, "x"), chunk(1, "", true)]);
    await reader.run();
    expect(read.mock.calls.map(([from]) => from)).toEqual([0, 0, 1]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("retries a failed read from the same offset, losing nothing", async () => {
    const { reader, read, written } = scripted([
      chunk(0, "ab"),
      new Error("IPC custom protocol failed"),
      chunk(2, "cd"),
      chunk(4, "", true),
    ]);
    await reader.run();
    expect(written).toEqual(["ab", "cd"]);
    expect(read.mock.calls.map(([from]) => from)).toEqual([0, 2, 2, 4]);
  });

  it("reads on past output the backend had to drop", async () => {
    const { reader, read } = scripted([chunk(0, "ab"), chunk(10, "z"), chunk(11, "", true)]);
    await reader.run();
    expect(read.mock.calls.map(([from]) => from)).toEqual([0, 2, 11]);
  });

  it("waits for the terminal to take a chunk before reading more", async () => {
    let taken: () => void = () => {};
    const read = vi.fn(async (from: number) => (from === 0 ? chunk(0, "big") : chunk(3, "", true)));
    const write = vi.fn(() => new Promise<void>((resolve) => (taken = resolve)));
    const running = new OutputReader({ read, write, retryDelayMs: 0 }).run();
    await settle();
    expect(read).toHaveBeenCalledTimes(1);

    taken();
    await running;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives up on a read that never settles and reads again from the same offset", async () => {
    vi.useFakeTimers();
    const replies: Array<Promise<OutputChunk>> = [new Promise(() => {}), Promise.resolve(chunk(0, "x", true))];
    const read = vi.fn((_from: number) => replies.shift() as Promise<OutputChunk>);
    const write = vi.fn(async () => {});
    const running = new OutputReader({ read, write, retryDelayMs: 0, readTimeoutMs: 50 }).run();
    await vi.advanceTimersByTimeAsync(60);
    await running;
    expect(read.mock.calls.map(([from]) => from)).toEqual([0, 0]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reports each unanswered read with how many went unanswered in a row", async () => {
    vi.useFakeTimers();
    const replies: Array<Promise<OutputChunk>> = [new Promise(() => {}), new Promise(() => {}), Promise.resolve(chunk(0, "", true))];
    const read = vi.fn((_from: number) => replies.shift() as Promise<OutputChunk>);
    const onReadTimeout = vi.fn();
    const deps = { read, write: vi.fn(async () => {}), retryDelayMs: 1, readTimeoutMs: 50, onReadTimeout };
    const running = new OutputReader(deps).run();
    await vi.advanceTimersByTimeAsync(200);
    await running;
    expect(onReadTimeout.mock.calls).toEqual([[1], [2]]);
  });

  /** A reader whose reads are answered by hand, with a 50 ms timeout and
   * a 10 ms retry delay. */
  function manual() {
    const replies: Array<(c: OutputChunk) => void> = [];
    const read = vi.fn((_from: number) => new Promise<OutputChunk>((resolve) => replies.push(resolve)));
    const written: string[] = [];
    const write = vi.fn(async (bytes: Uint8Array) => {
      written.push(new TextDecoder().decode(bytes));
    });
    const reader = new OutputReader({ read, write, retryDelayMs: 10, readTimeoutMs: 50 });
    return { reader, read, replies, written };
  }

  it("ignores a late reply to a read it gave up on, and writes its bytes once", async () => {
    vi.useFakeTimers();
    const { reader, read, replies, written } = manual();
    const running = reader.run();
    await vi.advanceTimersByTimeAsync(50);

    replies[0]?.(chunk(0, "late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    replies[1]?.(chunk(0, "late", true));
    await running;

    expect(written).toEqual(["late"]);
    expect(read.mock.calls.map(([from]) => from)).toEqual([0, 0]);
  });

  it("waits longer after each unanswered read, so a stalled IPC doesn't pile them up", async () => {
    vi.useFakeTimers();
    const { reader, read } = manual();
    void reader.run();

    await vi.advanceTimersByTimeAsync(50 + 10);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50 + 19);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(50 + 40);
    expect(read).toHaveBeenCalledTimes(4);
    reader.stop();
  });

  it("caps the wait between unanswered reads at 8 s", async () => {
    vi.useFakeTimers();
    const read = vi.fn((_from: number) => new Promise<OutputChunk>(() => {}));
    const reader = new OutputReader({ read, write: async () => {}, retryDelayMs: 1_000, readTimeoutMs: 50 });
    void reader.run();

    // Waits of 1, 2, 4 and 8 s, then 8 s again instead of 16.
    await vi.advanceTimersByTimeAsync(5 * 50 + 1_000 + 2_000 + 4_000 + 8_000 + 8_000);
    expect(read).toHaveBeenCalledTimes(6);
    reader.stop();
  });

  it("goes back to the short retry delay after a read is answered", async () => {
    vi.useFakeTimers();
    const { reader, read, replies } = manual();
    void reader.run();
    await vi.advanceTimersByTimeAsync(50 + 10 + 50 + 20);
    expect(read).toHaveBeenCalledTimes(3);

    replies[2]?.(chunk(0, "x"));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(50 + 10);
    expect(read).toHaveBeenCalledTimes(5);
    reader.stop();
  });

  it("stops: nothing more is read or written", async () => {
    let reply: (c: OutputChunk) => void = () => {};
    const read = vi.fn(() => new Promise<OutputChunk>((resolve) => (reply = resolve)));
    const write = vi.fn(async () => {});
    const reader = new OutputReader({ read, write, retryDelayMs: 0 });
    const running = reader.run();
    await settle();

    reader.stop();
    reply(chunk(0, "late"));
    await running;
    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
