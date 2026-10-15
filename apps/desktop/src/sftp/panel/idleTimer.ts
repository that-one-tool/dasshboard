/** A one-shot countdown in minutes; `0` minutes means off. */
export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onTimeout: () => void) {}

  arm(minutes: number): void {
    this.clear();
    if (minutes <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onTimeout();
    }, minutes * 60_000);
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
