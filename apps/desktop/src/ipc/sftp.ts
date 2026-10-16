import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeChecked, invokeMutation } from "./invoke";

/* ============================================================================
 * SFTP commands (the Files drawer) — file browse + up/download over SFTP.
 * These operate on a live SSH connection, not on config files, so they use
 * `invokeChecked` (no multi-instance config-echo suppression).
 * ============================================================================ */

/** One remote directory entry from `sftpList`. */
export interface SftpEntry {
  name: string;
  kind: "dir" | "file" | "symlink";
  size: number;
  /** Unix seconds; absent when the server omits it. */
  modified?: number;
  /** Unix permission bits (`0o7777` mask); absent when the server omits mode. */
  mode?: number;
}

/**
 * Opens an SFTP connection to a device (reusing the shell connect + host-key
 * path). Returns the starting directory (the server's home). A first-contact
 * host key raises the same `host_key_prompt` a shell connect does.
 */
export async function sftpConnect(deviceId: string): Promise<string> {
  return invokeChecked<string>("sftp_connect", { deviceId });
}

/** Closes a device's SFTP connection (idempotent). */
export async function sftpDisconnect(deviceId: string): Promise<void> {
  await invokeChecked<void>("sftp_disconnect", { deviceId });
}

/** Device ids with a live SFTP connection, so a re-mounted drawer can restore. */
export async function sftpConnectedDevices(): Promise<string[]> {
  return invokeChecked<string[]>("sftp_connected_devices");
}

/** Lists a remote directory (directories first, then files, each sorted). */
export async function sftpList(
  deviceId: string,
  path: string,
): Promise<SftpEntry[]> {
  return invokeChecked<SftpEntry[]>("sftp_list", { deviceId, path });
}

/** Resolves a remote path to its canonical absolute form (`realpath`). */
export async function sftpRealpath(
  deviceId: string,
  path: string,
): Promise<string> {
  return invokeChecked<string>("sftp_realpath", { deviceId, path });
}

/**
 * Downloads a remote file to a local path (from the native save dialog).
 * Returns the byte count written.
 */
export async function sftpDownload(
  deviceId: string,
  remotePath: string,
  localPath: string,
): Promise<number> {
  return invokeChecked<number>("sftp_download", {
    deviceId,
    remotePath,
    localPath,
  });
}

/**
 * Uploads a local file (from the native open dialog) to a remote path. Returns
 * the byte count uploaded.
 */
export async function sftpUpload(
  deviceId: string,
  localPath: string,
  remotePath: string,
): Promise<number> {
  return invokeChecked<number>("sftp_upload", {
    deviceId,
    localPath,
    remotePath,
  });
}

/** How a recursive folder transfer resolves a name that already exists at the
 * destination (chosen once per operation): replace, merge-keeping-existing, or
 * write under a fresh `<name> (N)`. */
export type ConflictPolicy = "overwrite" | "skip" | "rename";

/** Recursively downloads a remote directory tree into `localPath` (the target
 * directory), applying `policy` to entries that already exist. Resolves the
 * remote paths it skipped: links to folders, broken links, special files
 * (devices, FIFOs), and names this computer can't store. */
export async function sftpDownloadDir(
  deviceId: string,
  remotePath: string,
  localPath: string,
  policy: ConflictPolicy,
): Promise<string[]> {
  return invokeChecked<string[]>("sftp_download_dir", { deviceId, remotePath, localPath, policy });
}

/** Recursively uploads a local directory tree into `remotePath` (the target
 * directory), applying `policy` to entries that already exist. Resolves the
 * relative paths it skipped: names that aren't valid Unicode. */
export async function sftpUploadDir(
  deviceId: string,
  localPath: string,
  remotePath: string,
  policy: ConflictPolicy,
): Promise<string[]> {
  return invokeChecked<string[]>("sftp_upload_dir", { deviceId, localPath, remotePath, policy });
}

/** Whether a local path exists (to decide whether to prompt for a conflict). */
export async function sftpLocalExists(path: string): Promise<boolean> {
  return invokeChecked<boolean>("sftp_local_exists", { path });
}

/** Whether a remote path exists (to decide whether to prompt for a conflict). */
export async function sftpExists(deviceId: string, path: string): Promise<boolean> {
  return invokeChecked<boolean>("sftp_exists", { deviceId, path });
}

/** Creates a remote directory. */
export async function sftpMkdir(deviceId: string, path: string): Promise<void> {
  await invokeChecked<void>("sftp_mkdir", { deviceId, path });
}

/** Renames/moves a remote entry. */
export async function sftpRename(
  deviceId: string,
  from: string,
  to: string,
): Promise<void> {
  await invokeChecked<void>("sftp_rename", { deviceId, from, to });
}

/**
 * Removes a remote entry: a file when `isDir` is false; a directory otherwise —
 * recursively (whole tree) when `recursive`, else only when already empty.
 */
export async function sftpRemove(
  deviceId: string,
  path: string,
  isDir: boolean,
  recursive = false,
): Promise<void> {
  await invokeChecked<void>("sftp_remove", { deviceId, path, isDir, recursive });
}

/** Changes a remote entry's Unix permission bits (chmod). `mode` is the low
 * `0o7777` bits; the server keeps the file-type bits. */
export async function sftpChmod(deviceId: string, path: string, mode: number): Promise<void> {
  await invokeChecked<void>("sftp_chmod", { deviceId, path, mode });
}

/** The saved bookmark paths for a device (in saved order; empty if none). */
export async function sftpBookmarks(deviceId: string): Promise<string[]> {
  return invokeChecked<string[]>("sftp_bookmarks", { deviceId });
}

/** Adds a remote path to a device's bookmarks (idempotent). Returns the list. */
export async function sftpBookmarkAdd(deviceId: string, path: string): Promise<string[]> {
  return invokeMutation<string[]>("sftp_bookmark_add", { deviceId, path });
}

/** Removes a remote path from a device's bookmarks (no-op if absent). Returns the list. */
export async function sftpBookmarkRemove(deviceId: string, path: string): Promise<string[]> {
  return invokeMutation<string[]>("sftp_bookmark_remove", { deviceId, path });
}

/**
 * Requests cancellation of the in-flight transfer for a device (if any). The
 * streaming download/upload rejects with an `AppError` whose code is
 * `"Cancelled"`. Idempotent — no active transfer is a no-op.
 */
export async function sftpCancelTransfer(deviceId: string): Promise<void> {
  await invokeChecked<void>("sftp_cancel_transfer", { deviceId });
}

/** Streamed transfer progress from the `sftp_progress` event. */
export interface SftpProgressEvent {
  deviceId: string;
  direction: "download" | "upload";
  transferred: number;
  /** Total bytes (0 when unknown); `transferred === total` marks completion. */
  total: number;
}

/**
 * Subscribes to `sftp_progress` events emitted (throttled) during an SFTP
 * upload/download. Returns an unlisten function.
 */
export async function onSftpProgress(
  handler: (event: SftpProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<SftpProgressEvent>("sftp_progress", (e) => handler(e.payload));
}
