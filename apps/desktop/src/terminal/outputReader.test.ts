import { describe, it, expect, vi } from "vitest";
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
