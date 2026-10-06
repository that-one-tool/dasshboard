/**
 * Edit-in-place for the Files panel, DOM-free like `transferQueue.ts`: tracks
 * the remote files open in an external editor and keeps each in sync.
 *
 * The backend downloads the file into a private copy, opens the editor and
 * watches the copy; on each save it emits `sftp_edit_changed`, routed here to
 * {@link EditSessions.handleChange}. A sync first asks the backend whether the
 * save changed anything and whether the remote moved too, then uploads through
 * the panel's transfer queue (one transfer per device at a time) — or, on a
 * conflict, lets the user overwrite the remote, discard their changes, or
 * leave them pending until the next save.
 */

import {
  sftpEditCheck,
  sftpEditClose,
  sftpEditDiscard,
  sftpEditLaunch,
  sftpEditOpen,
  sftpEditUpload,
  sftpEditableSize,
  type AppError,
  type SftpEditCheck,
  type SftpEditInfo,
  type SftpEditUpload,
} from "../ipc";
import { t } from "../i18n";
import type { EditConflictChoice } from "../ui/confirm";
import { formatSize } from "./sftpFormat";
import type { TransferDirection } from "./transferQueue";

/** Files above this size ask before being opened for editing. */
export const LARGE_EDIT_BYTES = 10 * 1024 * 1024;

/** `synced`: the remote holds the saved content. `syncing`: a check, upload or
 * re-download is in flight. `pending`: saved changes not uploaded (a conflict
 * left open, or a failed upload); the next save tries again. */
export type EditStatus = "synced" | "syncing" | "pending";

export interface EditEntry {
  readonly info: SftpEditInfo;
  status: EditStatus;
}

export interface EditTransferSpec<T> {
  deviceId: string;
  direction: TransferDirection;
  name: string;
  /** False for uploads: a cancel would leave the remote file half-written. */
  cancellable: boolean;
  run: () => Promise<T>;
}

export interface EditSessionsHooks {
  /** Runs a transfer through the panel's queue, settling with its result. The
   * queue reports a failure itself. */
  runTransfer: <T>(spec: EditTransferSpec<T>) => Promise<T>;
  confirm: (message: string) => Promise<boolean>;
  /** Resolves `null` when the user leaves the conflict open. */
  chooseConflict: (name: string) => Promise<EditConflictChoice | null>;
  onChange: () => void;
  onError: (error: AppError) => void;
  onSuccess: (message: string) => void;
}

interface InternalEntry extends EditEntry {
  /** A save arrived while syncing: sync again once done. */
  again: boolean;
}

export class EditSessions {
  private edits = new Map<string, InternalEntry>();
  /** Opens in flight, by device + path, so a double click opens once. */
  private opening = new Map<string, Promise<void>>();
  /** Bumped by {@link closeDevice}: an open that started before is stale. */
  private generations = new Map<string, number>();

  constructor(private readonly hooks: EditSessionsHooks) {}

  entries(): EditEntry[] {
    return [...this.edits.values()].map(({ info, status }) => ({ info, status }));
  }

  hasEdits(deviceId: string): boolean {
    return this.forDevice(deviceId).length > 0;
  }

  /** Edits of a device whose saved changes are not (yet) on the remote. */
  unsyncedCount(deviceId: string): number {
    return this.forDevice(deviceId).filter((e) => e.status !== "synced").length;
  }

  /** Open `remotePath` for editing, or bring its editor back when it already is. */
  open(deviceId: string, remotePath: string, name: string): Promise<void> {
    const key = `${deviceId}\n${remotePath}`;
    const pending = this.opening.get(key) ?? this.openOnce(deviceId, remotePath, name);
    this.opening.set(key, pending);
    return pending.finally(() => this.opening.delete(key));
  }

  async relaunch(editId: string): Promise<void> {
    try {
      await sftpEditLaunch(editId);
    } catch (err) {
      this.hooks.onError(err as AppError);
    }
  }

  /** A save of the edit's local copy (the `sftp_edit_changed` event). */
  async handleChange(editId: string): Promise<void> {
    const entry = this.edits.get(editId);
    if (!entry) return;
    if (entry.status === "syncing") {
      entry.again = true;
      return;
    }
    await this.syncUntilSettled(entry);
  }

  /** End an edit, asking first when its changes are not uploaded. */
  async stop(editId: string): Promise<void> {
    const entry = this.edits.get(editId);
    if (!entry || !(await this.mayStop(entry))) return;
    this.edits.delete(editId);
    this.hooks.onChange();
    try {
      await sftpEditClose(editId);
    } catch (err) {
      this.hooks.onError(err as AppError);
    }
  }

  /** Forget a device's edits: its connection is closing, and the backend ends
   * them with it. An open still in flight is dropped when it lands. */
  closeDevice(deviceId: string): void {
    this.generations.set(deviceId, this.generationOf(deviceId) + 1);
    const ids = this.forDevice(deviceId).map((e) => e.info.editId);
    for (const id of ids) this.edits.delete(id);
    if (ids.length > 0) this.hooks.onChange();
  }

  private async openOnce(deviceId: string, remotePath: string, name: string): Promise<void> {
    const existing = this.find(deviceId, remotePath);
    if (existing) return this.relaunch(existing.info.editId);
    if (await this.sizeAccepted(deviceId, remotePath, name)) {
      await this.download(deviceId, remotePath, name);
    }
  }

  /** The size of the file the path points to (a symlink's target, not the
   * link), confirmed when large; a folder is reported and refused. */
  private async sizeAccepted(deviceId: string, remotePath: string, name: string): Promise<boolean> {
    let size: number;
    try {
      size = await sftpEditableSize(deviceId, remotePath);
    } catch (err) {
      this.hooks.onError(err as AppError);
      return false;
    }
    return size <= LARGE_EDIT_BYTES || this.confirmLarge(name, size);
  }

  private async download(deviceId: string, remotePath: string, name: string): Promise<void> {
    const generation = this.generationOf(deviceId);
    const info = await this.transfer({
      deviceId,
      direction: "download",
      name,
      cancellable: true,
      run: () => sftpEditOpen(deviceId, remotePath),
    });
    if (!info) return;
    if (generation !== this.generationOf(deviceId)) return this.dropStale(info.editId);
    this.edits.set(info.editId, { info, status: "synced", again: false });
    this.hooks.onChange();
  }

  /** End an edit that finished opening after its device closed. */
  private async dropStale(editId: string): Promise<void> {
    try {
      await sftpEditClose(editId);
    } catch {
      // The backend already ended it along with the connection.
    }
  }

  private async syncUntilSettled(entry: InternalEntry): Promise<void> {
    do {
      entry.again = false;
      await this.sync(entry);
    } while (entry.again && this.edits.has(entry.info.editId));
  }

  private async sync(entry: InternalEntry): Promise<void> {
    this.setStatus(entry, "syncing");
    const check = await this.checkOrReport(entry);
    if (check === null) return this.setStatus(entry, "pending");
    return this.afterCheck[check](entry);
  }

  private readonly afterCheck: Record<SftpEditCheck, (entry: InternalEntry) => void | Promise<void>> = {
    unchanged: (entry) => this.setStatus(entry, "synced"),
    clean: (entry) => this.upload(entry, false),
    conflict: (entry) => this.resolveConflict(entry),
  };

  private async checkOrReport(entry: InternalEntry): Promise<SftpEditCheck | null> {
    try {
      return await sftpEditCheck(entry.info.editId);
    } catch (err) {
      this.hooks.onError(err as AppError);
      return null;
    }
  }

  private async upload(entry: InternalEntry, overwrite: boolean): Promise<void> {
    const { editId, deviceId, name } = entry.info;
    const outcome = await this.transfer({
      deviceId,
      direction: "upload",
      name,
      cancellable: false,
      run: () => sftpEditUpload(editId, overwrite),
    });
    if (outcome === "conflict") return this.resolveConflict(entry);
    this.finishUpload(entry, outcome);
  }

  private finishUpload(entry: InternalEntry, outcome: SftpEditUpload | null): void {
    if (outcome === "uploaded") {
      this.hooks.onSuccess(t("sftp.edit.uploadedToast", { name: entry.info.name }));
    }
    this.setStatus(entry, outcome ? "synced" : "pending");
  }

  private async resolveConflict(entry: InternalEntry): Promise<void> {
    const choice = await this.hooks.chooseConflict(entry.info.name);
    if (choice === "overwrite") return this.upload(entry, true);
    if (choice === "discard") return this.discard(entry);
    this.setStatus(entry, "pending");
  }

  private async discard(entry: InternalEntry): Promise<void> {
    const { editId, deviceId, name } = entry.info;
    const done = await this.transfer({
      deviceId,
      direction: "download",
      name,
      cancellable: true,
      run: async () => {
        await sftpEditDiscard(editId);
        return true;
      },
    });
    this.setStatus(entry, done ? "synced" : "pending");
  }

  /** Run one queued transfer; `null` when it failed (already reported by the
   * queue) or was cancelled. */
  private async transfer<T>(spec: EditTransferSpec<T>): Promise<T | null> {
    try {
      return await this.hooks.runTransfer(spec);
    } catch {
      return null;
    }
  }

  private mayStop(entry: InternalEntry): Promise<boolean> | boolean {
    return (
      entry.status === "synced" ||
      this.hooks.confirm(t("sftp.edit.stopConfirm", { name: entry.info.name }))
    );
  }

  private confirmLarge(name: string, size: number): Promise<boolean> {
    return this.hooks.confirm(t("sftp.edit.largeConfirm", { name, size: formatSize(size) }));
  }

  private setStatus(entry: InternalEntry, status: EditStatus): void {
    entry.status = status;
    this.hooks.onChange();
  }

  private generationOf(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0;
  }

  private find(deviceId: string, remotePath: string): EditEntry | undefined {
    return this.forDevice(deviceId).find((e) => e.info.remotePath === remotePath);
  }

  private forDevice(deviceId: string): EditEntry[] {
    return this.entries().filter((e) => e.info.deviceId === deviceId);
  }
}
