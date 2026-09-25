/**
 * A small, DOM-free transfer queue for the SFTP panel. It exists so up/downloads
 * run **in the background** — one at a time per device — while the user keeps
 * browsing, instead of the old model where a single transfer locked the toolbar.
 *
 * The queue is deliberately generic: each item carries a `run` thunk (which calls
 * the real `sftp_*` transfer command) and the queue just serializes them and
 * tracks state. Progress arrives out-of-band from the backend's throttled
 * `sftp_progress` event, routed in via {@link TransferQueue.applyProgress}. This
 * keeps the queue logic unit-testable with fake `run`s and no Tauri/DOM.
 *
 * Concurrency: the SFTP panel browses one device at a time, so every enqueued
 * item targets the connected device and the worker runs strictly sequentially
 * (the backend also allows only one in-flight transfer per connection). When the
 * panel switches device or disconnects it calls {@link cancelDevice}, which
 * cancels the active transfer and drops that device's items so nothing runs
 * against a dead connection.
 */

import type { AppError } from "../ipc";

export type TransferDirection = "download" | "upload";

/** Lifecycle of one queued transfer. `queued`/`active` are live; the other three
 * are terminal. */
export type TransferState = "queued" | "active" | "done" | "failed" | "cancelled";

/** The public, read-only view of a queue item the panel renders. */
export interface TransferItem {
  readonly id: number;
  readonly deviceId: string;
  readonly direction: TransferDirection;
  /** A recursive folder transfer (vs. a single file) — a label/icon hint. */
  readonly isDir: boolean;
  /** Display name (basename of the file/folder). */
  readonly name: string;
  state: TransferState;
  transferred: number;
  /** Total bytes (0 until known); for a folder it tracks the current file only. */
  total: number;
  error?: AppError;
}

/** What the caller passes to enqueue a transfer. */
export interface EnqueueSpec {
  deviceId: string;
  direction: TransferDirection;
  isDir: boolean;
  name: string;
  /** Performs the transfer; resolves on success, rejects with an `AppError`
   * (`code === "Cancelled"` for a user cancel). */
  run: () => Promise<unknown>;
  /** A toast to surface via `onComplete` when the item finishes successfully. */
  successToast?: string;
  /** A remote directory to re-list on success (uploads add an entry to it), so
   * the panel can reflect the new file if it is still showing that directory. */
  refreshDir?: string;
}

export interface TransferQueueHooks {
  /** Ask the backend to cancel the in-flight transfer for a device
   * (`sftpCancelTransfer`); the active item's `run` then rejects with Cancelled. */
  cancelActive: (deviceId: string) => void;
  /** Fired on any structural change (enqueue, state transition, removal), so the
   * panel can re-render the list. NOT fired for progress ticks — see
   * {@link onProgress} — to avoid rebuilding the list ~20×/s. */
  onChange: () => void;
  /** Fired for a progress tick on the given (active) item, so the panel can
   * update just that row's bar in place rather than rebuilding the whole list. */
  onProgress: (item: TransferItem) => void;
  /** Fired once when an item reaches a terminal state, for a success toast, an
   * error surface, or a directory refresh. Not fired for items dropped by
   * {@link TransferQueue.cancelDevice}. */
  onComplete: (item: TransferItem, ctx: { successToast?: string; refreshDir?: string }) => void;
}

interface InternalItem extends TransferItem {
  run: () => Promise<unknown>;
  successToast?: string;
  refreshDir?: string;
}

export class TransferQueue {
  private queue: InternalItem[] = [];
  private nextId = 1;
  /** True while an item is in flight, so the worker never starts a second. */
  private running = false;

  constructor(private readonly hooks: TransferQueueHooks) {}

  /** The current items, oldest first (a live view — the panel only reads it). */
  items(): readonly TransferItem[] {
    return this.queue;
  }

  /** Whether any item is queued or active (drives the panel's queue visibility). */
  hasLive(): boolean {
    return this.queue.some((i) => i.state === "queued" || i.state === "active");
  }

  /** Add a transfer and kick the worker. Returns the new item's id. */
  enqueue(spec: EnqueueSpec): number {
    const item: InternalItem = {
      id: this.nextId++,
      deviceId: spec.deviceId,
      direction: spec.direction,
      isDir: spec.isDir,
      name: spec.name,
      state: "queued",
      transferred: 0,
      total: 0,
      run: spec.run,
      successToast: spec.successToast,
      refreshDir: spec.refreshDir,
    };
    this.queue.push(item);
    this.hooks.onChange();
    this.pump();
    return item.id;
  }

  /**
   * Cancel one item by id: a queued item is marked cancelled and never runs; an
   * active item is cancelled through the backend (its `run` rejects and the
   * worker records the cancellation). Terminal items are ignored.
   */
  cancel(id: number): void {
    const item = this.queue.find((i) => i.id === id);
    if (!item) return;
    if (item.state === "queued") {
      item.state = "cancelled";
      this.hooks.onChange();
      this.hooks.onComplete(item, {});
    } else if (item.state === "active") {
      this.hooks.cancelActive(item.deviceId);
    }
  }

  /** Remove one finished (done/failed/cancelled) item from the list. */
  remove(id: number): void {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      (i) => i.id !== id || i.state === "queued" || i.state === "active",
    );
    if (this.queue.length !== before) this.hooks.onChange();
  }

  /** Drop every finished item, keeping only the live (queued/active) ones. */
  clearFinished(): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((i) => i.state === "queued" || i.state === "active");
    if (this.queue.length !== before) this.hooks.onChange();
  }

  /**
   * Cancel and forget every item for a device — used when the panel switches
   * device or disconnects, so nothing runs against a torn-down connection. The
   * active item (if any) is cancelled backend-side; its later rejection is
   * ignored because the item is no longer in the queue.
   */
  cancelDevice(deviceId: string): void {
    if (!this.queue.some((i) => i.deviceId === deviceId)) return;
    for (const i of this.queue) {
      if (i.deviceId === deviceId && i.state === "active") this.hooks.cancelActive(deviceId);
    }
    this.queue = this.queue.filter((i) => i.deviceId !== deviceId);
    this.hooks.onChange();
  }

  /**
   * Route a backend `sftp_progress` tick to the active item for that device.
   * Ignored if no item is active (e.g. a late event after completion).
   */
  applyProgress(deviceId: string, transferred: number, total: number): void {
    const active = this.queue.find((i) => i.state === "active" && i.deviceId === deviceId);
    if (!active) return;
    active.transferred = transferred;
    if (total > 0) active.total = total;
    this.hooks.onProgress(active);
  }

  /** Start the next queued item if idle. */
  private pump(): void {
    if (this.running) return;
    const next = this.queue.find((i) => i.state === "queued");
    if (!next) return;
    this.running = true;
    next.state = "active";
    this.hooks.onChange();
    void next.run().then(
      () => this.finish(next, "done"),
      (err: unknown) => {
        const e = err as AppError;
        this.finish(next, e?.code === "Cancelled" ? "cancelled" : "failed", e);
      },
    );
  }

  /** Record an item's terminal state and advance the worker. Skips the hooks for
   * an item that {@link cancelDevice} already dropped (it is no longer shown). */
  private finish(item: InternalItem, state: TransferState, error?: AppError): void {
    this.running = false;
    item.state = state;
    if (state === "done" && item.total > 0) item.transferred = item.total;
    if (error) item.error = error;
    if (this.queue.includes(item)) {
      this.hooks.onChange();
      this.hooks.onComplete(item, { successToast: item.successToast, refreshDir: item.refreshDir });
    }
    this.pump();
  }
}
