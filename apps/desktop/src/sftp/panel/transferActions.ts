/** Queuing the Files panel's downloads and uploads: one file, one folder
 * tree, or one entry of a bulk download. Conflicts are resolved per
 * operation (folders) or when the item runs (files). */

import { basename, join } from "@tauri-apps/api/path";
import {
  sftpDownload,
  sftpDownloadDir,
  sftpExists,
  sftpLocalExists,
  sftpUpload,
  sftpUploadDir,
  type AppError,
  type ConflictPolicy,
  type SftpEntry,
} from "../../ipc";
import { t, tp } from "../../i18n";
import { pickDownloadDirPath, pickDownloadSavePath, pickUploadDirPath, pickUploadOpenPath } from "../../ui/fileDialog";
import { isLocalFileName, joinRemote, skippedSummary } from "../sftpFormat";
import type { EnqueueSpec } from "../transferQueue";
import type { RemotePlace } from "./directoryBrowser";
import type { PanelFeedback } from "./panelFeedback";
import { bulkFileDestination, conflictMessage, resolvePolicy, uploadTarget } from "./transferConflicts";

export interface TransferDeps {
  feedback: PanelFeedback;
  enqueue: (spec: EnqueueSpec) => number;
  place: () => RemotePlace | null;
  /** Whether `place` is still the listing on screen. */
  isAt: (place: RemotePlace) => boolean;
  clearHover: () => void;
}

type SkippedKey = "sftp.download.skipped" | "sftp.upload.skipped";

export class TransferActions {
  constructor(private readonly deps: TransferDeps) {}

  /** Download one file to a path picked in the save dialog. */
  async download(entry: SftpEntry): Promise<void> {
    const place = this.downloadPlace([entry]);
    if (place === null) return;
    const local = await pickDownloadSavePath(entry.name);
    if (local !== null) this.queueDownload(place, entry, local);
  }

  /** Recursively download a folder into a chosen local directory, resolving
   * a name clash with a per-operation conflict policy. */
  async downloadFolder(entry: SftpEntry): Promise<void> {
    const place = this.downloadPlace([entry]);
    if (place === null) return;
    const destParent = await pickDownloadDirPath();
    if (destParent !== null) await this.queueFolderDownload(place, entry, destParent);
  }

  /** Upload one picked file into the current directory. */
  async upload(): Promise<void> {
    const place = this.deps.place();
    if (place === null) return;
    const local = await pickUploadOpenPath();
    if (local !== null) await this.queueUpload(place, local);
  }

  /** Recursively upload a picked local folder into the current directory. */
  async uploadFolder(): Promise<void> {
    const place = this.deps.place();
    if (place === null) return;
    const localDir = await pickUploadDirPath();
    if (localDir !== null) await this.queueFolderUpload(place, localDir);
  }

  /** Reports the first entry whose name can't be a local file name (see
   * `isLocalFileName`); true when the download must not go ahead. */
  refuseUnsafeNames(entries: readonly SftpEntry[]): boolean {
    const unsafe = entries.find((entry) => !isLocalFileName(entry.name));
    if (!unsafe) return false;
    const message = t("sftp.download.unsafeName", { name: unsafe.name });
    this.deps.feedback.notify({ code: "Validation", message } satisfies AppError);
    return true;
  }

  /** Queue one entry of a bulk download (quiet: the queue list is the
   * feedback); skip/rename are resolved per file when it runs. */
  queueBulkItem(deviceId: string, remote: string, entry: SftpEntry, target: string, policy: ConflictPolicy): void {
    const isDir = entry.kind === "dir";
    this.deps.enqueue({
      deviceId,
      direction: "download",
      isDir,
      name: entry.name,
      run: isDir
        ? () => this.fetchFolder(deviceId, remote, target, policy)
        : () => this.fetchFileTo(deviceId, remote, target, entry.name, policy),
    });
  }

  /** Where a download of `entries` comes from, or `null` when not connected
   * or a name can't be stored locally (reported). Clears the row hover before
   * a dialog opens. */
  private downloadPlace(entries: readonly SftpEntry[]): RemotePlace | null {
    const place = this.deps.place();
    if (place === null) return null;
    this.deps.clearHover();
    return this.refuseUnsafeNames(entries) ? null : place;
  }

  /** The conflict policy, or `null` when cancelled or when another device or
   * directory took over while the conflict dialog was open. */
  private async policyAt(place: RemotePlace, conflict: boolean, name: string): Promise<ConflictPolicy | null> {
    const policy = await resolvePolicy(conflict, conflictMessage(name));
    return this.deps.isAt(place) ? policy : null;
  }

  private queueDownload(place: RemotePlace, entry: SftpEntry, local: string): void {
    if (!this.deps.isAt(place)) return;
    const { deviceId } = place;
    const remote = joinRemote(place.dir, entry.name);
    this.deps.enqueue({
      deviceId,
      direction: "download",
      isDir: false,
      name: entry.name,
      run: () => sftpDownload(deviceId, remote, local),
      successToast: t("sftp.downloadedToast", { name: entry.name }),
    });
  }

  private async queueFolderDownload(place: RemotePlace, entry: SftpEntry, destParent: string): Promise<void> {
    if (!this.deps.isAt(place)) return;
    const { deviceId } = place;
    const remote = joinRemote(place.dir, entry.name);
    const target = await join(destParent, entry.name);
    const policy = await this.policyAt(place, await sftpLocalExists(target), entry.name);
    if (policy === null) return;
    this.deps.enqueue({
      deviceId,
      direction: "download",
      isDir: true,
      name: entry.name,
      run: () => this.fetchFolder(deviceId, remote, target, policy),
      successToast: t("sftp.downloadedFolderToast", { name: entry.name }),
    });
  }

  private async queueUpload(place: RemotePlace, local: string): Promise<void> {
    if (!this.deps.isAt(place)) return;
    const { deviceId, dir } = place;
    const name = await basename(local);
    const remote = joinRemote(dir, name);
    this.deps.enqueue({
      deviceId,
      direction: "upload",
      isDir: false,
      name,
      run: () => this.sendFile(deviceId, local, remote, name),
      successToast: t("sftp.uploadedToast", { name }),
      refreshDir: dir,
    });
  }

  private async queueFolderUpload(place: RemotePlace, localDir: string): Promise<void> {
    if (!this.deps.isAt(place)) return;
    const { deviceId, dir } = place;
    const name = await basename(localDir);
    const target = joinRemote(dir, name);
    const policy = await this.policyAt(place, await sftpExists(deviceId, target), name);
    if (policy === null) return;
    this.deps.enqueue({
      deviceId,
      direction: "upload",
      isDir: true,
      name,
      run: () => this.sendFolder(deviceId, localDir, target, policy),
      successToast: t("sftp.uploadedFolderToast", { name }),
      refreshDir: dir,
    });
  }

  /** Downloads a folder tree, then reports any entries it had to skip (one
   * odd entry doesn't stop the rest). */
  private async fetchFolder(deviceId: string, remote: string, target: string, policy: ConflictPolicy): Promise<void> {
    const skipped = await sftpDownloadDir(deviceId, remote, target, policy);
    this.reportSkipped("sftp.download.skipped", remote, skipped);
  }

  /** Uploads a folder tree, then reports any entries it had to skip. */
  private async sendFolder(deviceId: string, localDir: string, target: string, policy: ConflictPolicy): Promise<void> {
    const skipped = await sftpUploadDir(deviceId, localDir, target, policy);
    this.reportSkipped("sftp.upload.skipped", target, skipped);
  }

  private async fetchFileTo(
    deviceId: string,
    remote: string,
    target: string,
    name: string,
    policy: ConflictPolicy,
  ): Promise<void> {
    const local = await bulkFileDestination(target, name, policy);
    if (local !== null) await sftpDownload(deviceId, remote, local);
  }

  /** Uploads one file, choosing where when its turn comes, not when it was
   * picked: a transfer ahead in the queue may create a file of that name
   * meanwhile. Skipping or cancelling the conflict dialog ends the item as a
   * quiet cancel. */
  private async sendFile(deviceId: string, local: string, remote: string, name: string): Promise<void> {
    const target = await uploadTarget(deviceId, remote, name);
    if (target === null) throw { code: "Cancelled", message: "" } satisfies AppError;
    await sftpUpload(deviceId, local, target);
  }

  private reportSkipped(key: SkippedKey, path: string, skipped: string[]): void {
    if (skipped.length === 0) return;
    const name = path.split("/").pop() ?? path;
    const message = tp(key, skipped.length, { name, items: skippedSummary(skipped) });
    this.deps.feedback.notify({ code: "Sftp", message } satisfies AppError);
  }
}
