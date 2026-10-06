/**
 * Keeps a pane's input in order. Each keystroke is its own `write_stdin` IPC
 * call and the backend may run two calls at once, so without this a fast
 * typist's keys could reach the shell out of order.
 */

/** Runs async sends one at a time, in the order they were pushed. A failed
 * send (the session just ended) doesn't stop the ones after it. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  push(send: () => Promise<void>): void {
    this.tail = this.tail.then(send).catch(() => {});
  }
}
