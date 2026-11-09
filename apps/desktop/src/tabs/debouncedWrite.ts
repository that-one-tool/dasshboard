/** Coalesces writes: `schedule` (re)starts a timer that runs `write` once it
 * expires; `flush` runs a pending write at once. */
export class DebouncedWrite {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: () => void,
    private readonly delayMs: number,
  ) {}

  schedule(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.delayMs);
  }

  /** Runs the pending write now; a no-op when none is pending. */
  flush(): void {
    if (this.timer === null) return;
    this.cancel();
    this.write();
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
