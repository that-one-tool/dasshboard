/** The device manager's toasts, always callable: each call reads the caller's
 * optional callback at that moment, so a missing one is a no-op. */

import type { AppError } from "../../ipc";

export interface DeviceFeedbackOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
}

export interface DeviceFeedback {
  error(error: unknown): void;
  success(message: string): void;
}

export function deviceFeedback(options: DeviceFeedbackOptions): DeviceFeedback {
  return {
    error: (error) => options.onError?.(error as AppError),
    success: (message) => options.onSuccess?.(message),
  };
}
