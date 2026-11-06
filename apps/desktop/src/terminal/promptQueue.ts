/** Backend prompts waiting for the user, shown one at a time in arrival order. */
export class PromptQueue<T extends { promptId: string }> {
  private readonly waiting: T[] = [];
  private shown: T | null = null;

  get current(): T | null {
    return this.shown;
  }

  /** Queue `prompt`; `true` when it is the one to show now. */
  push(prompt: T): boolean {
    if (this.shown) {
      this.waiting.push(prompt);
      return false;
    }
    this.shown = prompt;
    return true;
  }

  /** Done with the shown prompt: the next one to show, if any. */
  advance(): T | null {
    this.shown = this.waiting.shift() ?? null;
    return this.shown;
  }

  /** The backend stopped waiting on `promptId`: `true` when it was the shown
   * one, so the view must show `current` instead. */
  drop(promptId: string): boolean {
    if (this.shown?.promptId === promptId) {
      this.advance();
      return true;
    }
    const kept = this.waiting.filter((p) => p.promptId !== promptId);
    this.waiting.splice(0, this.waiting.length, ...kept);
    return false;
  }
}
