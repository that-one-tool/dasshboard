/**
 * Pulls a session's output into its terminal (see `read_output`). Each read
 * names the offset it continues from, which also tells the backend the bytes
 * before it arrived; a read that fails is retried from the same offset, so
 * a lost IPC reply can neither drop output nor stall the terminal. The next
 * read waits until the terminal has taken the last chunk, so a busy terminal
 * slows the stream instead of queueing it all.
 */

import type { OutputChunk } from "../ipc";

export interface OutputReaderDeps {
  /** The output after offset `from`. */
  read: (from: number) => Promise<OutputChunk>;
  /** Resolves once the terminal has processed `bytes`. */
  write: (bytes: Uint8Array) => Promise<void>;
  /** Pause before retrying a failed read. */
  retryDelayMs?: number;
}

const RETRY_DELAY_MS = 250;

export class OutputReader {
  private offset = 0;
  private stopped = false;

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
    try {
      return await this.deps.read(this.offset);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, this.deps.retryDelayMs ?? RETRY_DELAY_MS));
      return null;
    }
  }

  /** Hand a chunk to the terminal; `true` once the output has ended. */
  private async take(chunk: OutputChunk): Promise<boolean> {
    if (chunk.bytes.length > 0) await this.deps.write(chunk.bytes);
    this.offset = chunk.start + chunk.bytes.length;
    return chunk.end;
  }
}
