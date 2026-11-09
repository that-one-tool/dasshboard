/** How the Files panel's parts tell the user how an operation went. */

import type { AppError } from "../../ipc";

export interface FeedbackHooks {
  notifyError: (error: AppError) => void;
  notifySuccess: (message: string) => void;
  /** Check whether the connection itself is gone (after an operation failed). */
  resync: () => void;
}

export class PanelFeedback {
  constructor(private readonly hooks: FeedbackHooks) {}

  success(message: string): void {
    this.hooks.notifySuccess(message);
  }

  /** Surface an error that says nothing about the connection. */
  notify(error: unknown): void {
    this.hooks.notifyError(error as AppError);
  }

  /** Surface an operation's error, then check whether it failed because the
   * connection itself is gone (server closed it, network dropped). */
  report(error: unknown): void {
    this.notify(error);
    this.hooks.resync();
  }

  /** Run `operation`, reporting a failure. */
  async attempt(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (err) {
      this.report(err);
    }
  }
}
