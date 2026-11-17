/**
 * Pulls a session's output into its terminal (see `read_output`). Each read
 * names the offset it continues from, which also tells the backend the bytes
 * before it arrived; a read that fails or never answers is retried from the
 * same offset, so a lost IPC reply can neither drop output nor stall the
 * terminal for good (a late reply to a read given up on is ignored: its bytes
 * come again). Each unanswered read in a row doubles the wait before the next,
 * so a stalled IPC isn't flooded with reads. The next read waits until the
 * terminal has taken the last chunk, so a busy terminal slows the stream
 * instead of queueing it all.
 */

import type { OutputChunk } from "../ipc";
import { TimeoutError, withTimeout } from "./timeout";

export interface OutputReaderDeps {
  /** The output after offset `from`. */
  read: (from: number) => Promise<OutputChunk>;
  /** Resolves once the terminal has processed `bytes`. */
  write: (bytes: Uint8Array) => Promise<void>;
  /** Pause before retrying a failed read. */
  retryDelayMs?: number;
  /** How long a read may take before it counts as failed. */
  readTimeoutMs?: number;
  /** A read went unanswered; `unanswered` counts them in a row. */
  onReadTimeout?: (unanswered: number) => void;
}

const RETRY_DELAY_MS = 250;
/** The backend's `READ_WAIT` (2 s) plus room for a busy IPC. */
const READ_TIMEOUT_MS = 7_000;
const MAX_BACKOFF_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class OutputReader {
  private offset = 0;
  private stopped = false;
  /** Reads in a row that went unanswered. */
  private unanswered = 0;

  constructor(private readonly deps: OutputReaderDeps) {}

  /** Read until the session's output ends, or `stop()`. */
  async run(): Promise<void> {
    while (!this.stopped) {
      if (await this.step()) return;
    }
  }

  /** Read and hand over one chunk; `true` once the output has ended. */
  private async step(): Promise<boolean> {
    const chunk = await this.next();
    if (!chunk || this.stopped) return false;
    return this.take(chunk);
  }

  stop(): void {
    this.stopped = true;
  }

  /** The next chunk, or `null` after a failed read (and a pause). */
  private async next(): Promise<OutputChunk | null> {
    const read = this.deps.read(this.offset);
    try {
      const chunk = await withTimeout(read, this.deps.readTimeoutMs ?? READ_TIMEOUT_MS);
      this.unanswered = 0;
      return chunk;
    } catch (error) {
      await this.pauseAfter(error, read);
      return null;
    }
  }

  private pauseAfter(error: unknown, read: Promise<OutputChunk>): Promise<void> {
    return error instanceof TimeoutError ? this.backOff(read) : sleep(this.retryDelayMs());
  }

  /** Waits for the unanswered `read` to settle, or for a backoff that doubles
   * with each unanswered read in a row. */
  private async backOff(read: Promise<OutputChunk>): Promise<void> {
    const delay = Math.min(this.retryDelayMs() * 2 ** this.unanswered, MAX_BACKOFF_MS);
    this.unanswered += 1;
    this.deps.onReadTimeout?.(this.unanswered);
    const settled = read.then(
      () => {},
      () => {},
    );
    await Promise.race([settled, sleep(delay)]);
  }

  private retryDelayMs(): number {
    return this.deps.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /** Hand a chunk to the terminal; `true` once the output has ended. */
  private async take(chunk: OutputChunk): Promise<boolean> {
    if (chunk.bytes.length > 0) await this.deps.write(chunk.bytes);
    this.offset = chunk.start + chunk.bytes.length;
    return chunk.end;
  }
}
