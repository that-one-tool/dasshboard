/**
 * Tells a stale async attempt from the latest one: an attempt that resolves
 * after a newer one began, or after `invalidate`, must not touch the panel.
 */
export class LatestAttempt {
  private latest = 0;

  begin(): number {
    this.latest += 1;
    return this.latest;
  }

  isCurrent(attempt: number): boolean {
    return attempt === this.latest;
  }

  invalidate(): void {
    this.latest += 1;
  }
}
