/** Edit-in-place transfers running through the transfer queue: each settles
 * the edit waiting on it, also when the queue ends it without running it. */

import type { AppError } from "../../ipc";
import { t } from "../../i18n";
import type { EditTransferSpec } from "../editSessions";
import type { EnqueueSpec, TransferItem } from "../transferQueue";

interface PendingEdit {
  deviceId: string;
  reject: (error: AppError) => void;
}

export class EditTransfers {
  /** Settles the queued edit transfers that end without running (cancelled
   * while queued, or dropped on disconnect); an active one settles through its
   * own `run`. Keyed by queue item id. */
  private pending = new Map<number, PendingEdit>();

  constructor(private readonly enqueue: (spec: EnqueueSpec) => number) {}

  /** Run an edit's download/upload through the queue, settling with its
   * result. A failure is reported by the queue itself. */
  run<T>(spec: EditTransferSpec<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.enqueue({
        deviceId: spec.deviceId,
        direction: spec.direction,
        isDir: false,
        name: spec.name,
        cancellable: spec.cancellable,
        run: () => spec.run().then(resolve, (err: unknown) => {
          reject(err);
          throw err;
        }),
      });
      this.pending.set(id, { deviceId: spec.deviceId, reject });
    });
  }

  /** Reject an edit transfer the queue ended without running it to success
   * (cancelled while queued), so the edit doesn't wait on it forever. */
  settle(item: TransferItem): void {
    const pending = this.pending.get(item.id);
    this.pending.delete(item.id);
    if (item.state === "done" || !pending) return;
    pending.reject(failureOf(item));
  }

  /** Settle a device's edit transfers the queue dropped without completing. */
  rejectDevice(deviceId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.deviceId !== deviceId) continue;
      this.pending.delete(id);
      pending.reject(cancelledError());
    }
  }
}

function failureOf(item: TransferItem): AppError {
  return item.error ?? cancelledError();
}

/** The error an edit's transfer settles with when it ends without running. */
function cancelledError(): AppError {
  return { code: "Cancelled", message: t("sftp.transferCancelled") };
}
