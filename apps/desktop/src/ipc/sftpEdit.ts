import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeChecked } from "./invoke";

/** A remote file open for editing in an external editor (`sftp_edit_open`). */
export interface SftpEditInfo {
  editId: string;
  deviceId: string;
  remotePath: string;
  /** Base name of the remote file. */
  name: string;
}

/** Whether a saved edit needs uploading: `unchanged` (same content as the last
 * sync), `clean` (safe to upload), or `conflict` (the remote changed too). */
export type SftpEditCheck = "unchanged" | "clean" | "conflict";

/** What an edit upload did; `conflict` means it was refused (not uploaded). */
export type SftpEditUpload = "uploaded" | "unchanged" | "conflict";

/**
 * Downloads a remote file into a private local copy, watches it, and opens it
 * in the configured editor (or the OS default app). Streams `sftp_progress`
 * like a download.
 */
export async function sftpEditOpen(deviceId: string, remotePath: string): Promise<SftpEditInfo> {
  return invokeChecked<SftpEditInfo>("sftp_edit_open", { deviceId, remotePath });
}

/** The size of the file `path` points to (following a symlink); rejects with
 * a `Validation` error for a folder. Checked before opening it for editing. */
export async function sftpEditableSize(deviceId: string, path: string): Promise<number> {
  return invokeChecked<number>("sftp_editable_size", { deviceId, path });
}

/** Opens an edit's local copy in the editor again. */
export async function sftpEditLaunch(editId: string): Promise<void> {
  await invokeChecked<void>("sftp_edit_launch", { editId });
}

/** Compares an edit's local copy and the remote file against the last sync. */
export async function sftpEditCheck(editId: string): Promise<SftpEditCheck> {
  return invokeChecked<SftpEditCheck>("sftp_edit_check", { editId });
}

/** Uploads an edit's local copy over the remote file; refused with `conflict`
 * when the remote changed, unless `overwrite`. Streams `sftp_progress`. */
export async function sftpEditUpload(editId: string, overwrite: boolean): Promise<SftpEditUpload> {
  return invokeChecked<SftpEditUpload>("sftp_edit_upload", { editId, overwrite });
}

/** Replaces an edit's local copy with the current remote file. */
export async function sftpEditDiscard(editId: string): Promise<void> {
  await invokeChecked<void>("sftp_edit_discard", { editId });
}

/** Ends an edit and deletes its local copy. Unknown ids are a no-op. */
export async function sftpEditClose(editId: string): Promise<void> {
  await invokeChecked<void>("sftp_edit_close", { editId });
}

/** Subscribes to `sftp_edit_changed`: an edit's local copy was saved. */
export async function onSftpEditChanged(handler: (editId: string) => void): Promise<UnlistenFn> {
  return listen<{ editId: string }>("sftp_edit_changed", (e) => handler(e.payload.editId));
}
