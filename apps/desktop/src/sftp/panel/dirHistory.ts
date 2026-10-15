/**
 * The Files panel's Back/Forward stack. The panel moves the cursor only once
 * the target directory listed, so a failed listing leaves history untouched.
 */
export class DirHistory {
  private paths: string[] = [];
  private index = -1;

  reset(): void {
    this.paths = [];
    this.index = -1;
  }

  isCurrent(path: string): boolean {
    return this.paths[this.index] === path;
  }

  /** Visit `path`: the forward entries are dropped. */
  record(path: string): void {
    this.paths = this.paths.slice(0, this.index + 1);
    this.paths.push(path);
    this.index = this.paths.length - 1;
  }

  backTarget(): string | undefined {
    return this.index > 0 ? this.paths[this.index - 1] : undefined;
  }

  forwardTarget(): string | undefined {
    return this.paths[this.index + 1];
  }

  canGoBack(): boolean {
    return this.backTarget() !== undefined;
  }

  canGoForward(): boolean {
    return this.forwardTarget() !== undefined;
  }

  stepBack(): void {
    if (this.canGoBack()) this.index -= 1;
  }

  stepForward(): void {
    if (this.canGoForward()) this.index += 1;
  }
}
