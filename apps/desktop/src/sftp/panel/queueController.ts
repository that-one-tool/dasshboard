/** The Files panel's background transfer queue: up/downloads run here while
 * browsing stays live. Renders the queue list, cancels, and reacts when an
 * item ends (toast, re-list, auto-hide, error). */

import { sftpCancelTransfer } from "../../ipc";
import { TransferQueue, type EnqueueSpec, type TransferItem } from "../transferQueue";
import { EditTransfers } from "./editTransfers";
import type { PanelElements } from "./panelElements";
import type { PanelFeedback } from "./panelFeedback";
import * as queueView from "./queueView";

/** How long a finished row stays before it clears itself. */
const DONE_ROW_MS = 3000;

export interface QueueDeps {
  els: () => PanelElements;
  feedback: PanelFeedback;
  /** An upload landed in `dir` on `deviceId` (re-list it if still on screen). */
  onLanded: (deviceId: string, dir: string) => void;
}

interface CompletionContext {
  successToast?: string;
  refreshDir?: string;
}

export class QueueController {
  private readonly queue = new TransferQueue({
    cancelActive: (deviceId) => void this.cancelActive(deviceId),
    onChange: () => this.render(),
    onProgress: (item) => this.updateProgress(item),
    onComplete: (item, ctx) => this.onComplete(item, ctx),
  });
  /** Edit-in-place transfers waiting on this queue. */
  readonly edits = new EditTransfers((spec) => this.queue.enqueue(spec));
  /** Per-item auto-remove timers for completed transfers (id → timer). */
  private hideTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: QueueDeps) {}

  enqueue(spec: EnqueueSpec): number {
    return this.queue.enqueue(spec);
  }

  /** A live progress event from the backend, for the device's active item. */
  applyProgress(deviceId: string, transferred: number, total: number): void {
    this.queue.applyProgress(deviceId, transferred, total);
  }

  cancel(id: number): void {
    this.queue.cancel(id);
  }

  /** Cancel + drop a device's transfers: its connection is going away. */
  cancelDevice(deviceId: string): void {
    this.queue.cancelDevice(deviceId);
    this.edits.rejectDevice(deviceId);
  }

  dismiss(id: number): void {
    clearTimeout(this.hideTimers.get(id));
    this.hideTimers.delete(id);
    this.queue.remove(id);
  }

  clearFinished(): void {
    this.clearHideTimers();
    this.queue.clearFinished();
  }

  /** Rebuild the transfer list; called on every queue change and after a
   * panel rebuild. */
  render(): void {
    queueView.renderQueue(this.deps.els().queue, this.queue.items());
  }

  /** Clear the auto-hide timers (the panel is disposed). */
  dispose(): void {
    this.clearHideTimers();
  }

  /** A progress tick: update the row in place, or re-render if it isn't there. */
  private updateProgress(item: TransferItem): void {
    if (!queueView.updateQueueRowProgress(this.deps.els().queue, item)) this.render();
  }

  /** Ask the backend to cancel the in-flight transfer for a device. */
  private async cancelActive(deviceId: string): Promise<void> {
    await this.deps.feedback.attempt(() => sftpCancelTransfer(deviceId));
  }

  /**
   * An item reached a terminal state. A success surfaces its toast (and
   * re-lists the directory an upload landed in), then auto-clears the row
   * after a moment; a real failure surfaces as an error and the row stays
   * until dismissed; a user cancel is quiet (the row stays too).
   */
  private onComplete(item: TransferItem, ctx: CompletionContext): void {
    this.edits.settle(item);
    if (item.state === "done") return this.onDone(item, ctx);
    if (item.state === "failed") this.reportFailure(item);
  }

  private onDone(item: TransferItem, ctx: CompletionContext): void {
    if (ctx.successToast) this.deps.feedback.success(ctx.successToast);
    if (ctx.refreshDir !== undefined) this.deps.onLanded(item.deviceId, ctx.refreshDir);
    this.scheduleHide(item.id);
  }

  private reportFailure(item: TransferItem): void {
    if (item.error) this.deps.feedback.report(item.error);
  }

  /** Auto-remove a completed transfer row after a short delay. */
  private scheduleHide(id: number): void {
    clearTimeout(this.hideTimers.get(id));
    const timer = setTimeout(() => {
      this.hideTimers.delete(id);
      this.queue.remove(id);
    }, DONE_ROW_MS);
    this.hideTimers.set(id, timer);
  }

  private clearHideTimers(): void {
    for (const timer of this.hideTimers.values()) clearTimeout(timer);
    this.hideTimers.clear();
  }
}
