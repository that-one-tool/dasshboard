/**
 * Keeps a pane's keystrokes in order. `write_stdin` calls are async, and IPC
 * replies can resolve out of order, so without serialising each send a fast
 * typist's keys could reach the shell out of order.
 */

export interface InputTimeouts {
  /** Long past a healthy send, which the backend answers once the session
   * has queued the keys. */
  stalledAfterMs: number;
  /** Past this, a key sent later could land before the unanswered one. */
  lostAfterMs: number;
}

const DEFAULT_TIMEOUTS: InputTimeouts = { stalledAfterMs: 10_000, lostAfterMs: 30_000 };

type Send = () => Promise<void>;

/** `stalled`: a send is late; `lost`: input stopped for good (reconnect). */
export type InputHealth = "ok" | "stalled" | "lost";

/**
 * Runs sends one at a time, in the order they were pushed, never two at once.
 * A send unanswered after the timeout marks the queue stalled; keys typed
 * meanwhile wait and go out in order if it answers. A send that fails, or
 * stays unanswered past the lost limit, stops the queue for good: it drops
 * every queued and later key, so the shell never gets input with a gap.
 */
export class InputQueue {
  private readonly pending: Send[] = [];
  private sending = false;
  private health: InputHealth = "ok";

  constructor(
    private readonly onHealthChange: (health: InputHealth) => void = () => {},
    private readonly timeouts = DEFAULT_TIMEOUTS,
  ) {}

  push(send: Send): void {
    if (this.health === "lost") return;
    this.pending.push(send);
    if (!this.sending) void this.drain();
  }

  private async drain(): Promise<void> {
    this.sending = true;
    for (let send = this.pending.shift(); send; send = this.pending.shift()) await this.sendOne(send);
    this.sending = false;
  }

  private async sendOne(send: Send): Promise<void> {
    const stallTimer = setTimeout(() => this.setHealth("stalled"), this.timeouts.stalledAfterMs);
    const lostTimer = setTimeout(() => this.stop(), this.timeouts.lostAfterMs);
    try {
      await send();
      this.setHealth("ok");
    } catch {
      this.stop();
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(lostTimer);
    }
  }

  private stop(): void {
    this.pending.length = 0;
    this.setHealth("lost");
  }

  private setHealth(health: InputHealth): void {
    if (health === this.health || this.health === "lost") return;
    this.health = health;
    this.onHealthChange(health);
  }
}
