/** Coalesces writes: `schedule` (re)starts a timer that runs `write` once it
 * expires; `flush` runs a pending write at once. A scheduled write never runs
 * beside another: one due while a write is in flight runs once that settles,
 * so an older state can't land on disk after a newer one. */
export class DebouncedWrite {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private writeAgain = false;

  constructor(
    private readonly write: () => Promise<void> | void,
    private readonly delayMs: number,
  ) {}

  schedule(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.delayMs);
  }

  /** Runs the pending write now, even beside one in flight (the app may be
   * closing, so waiting could lose it); a no-op when none is pending. */
  flush(): void {
    if (this.timer === null && !this.writeAgain) return;
    this.cancel();
    // The backend may commit the two writes in either order: write once more
    // after both, so the latest state lands last.
    this.writeAgain = this.inFlight > 0;
    void this.writeNow();
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(): void {
    if (this.inFlight > 0) {
      this.writeAgain = true;
      return;
    }
    void this.writeNow();
  }

  private async writeNow(): Promise<void> {
    this.inFlight += 1;
    try {
      await this.write();
    } catch {
      // The caller's `write` reports its own failures.
    } finally {
      this.inFlight -= 1;
    }
    this.runIfAsked();
  }

  private runIfAsked(): void {
    if (!this.writeAgain) return;
    this.writeAgain = false;
    this.run();
  }
}
