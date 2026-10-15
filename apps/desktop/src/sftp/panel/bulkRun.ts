/** Running a bulk operation's items, one at a time, past failures. */

import type { AppError } from "../../ipc";

export interface BulkResult {
  done: number;
  firstError: AppError | null;
}

export type BulkOutcome = "partial" | "success" | "nothing";

/** Run `items` sequentially; one failing doesn't stop the rest. */
export async function runEach<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<BulkResult> {
  const result: BulkResult = { done: 0, firstError: null };
  for (const item of items) tally(result, await captureError(() => run(item)));
  return result;
}

function tally(result: BulkResult, error: AppError | null): void {
  if (error) result.firstError ??= error;
  else result.done += 1;
}

async function captureError(run: () => Promise<void>): Promise<AppError | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err as AppError;
  }
}

export function getBulkOutcome(result: BulkResult): BulkOutcome {
  if (result.firstError) return "partial";
  return result.done > 0 ? "success" : "nothing";
}
