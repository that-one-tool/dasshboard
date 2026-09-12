/**
 * Thin, typed wrappers over the Tauri dialog plugin's native `save`/`open`
 * pickers, scoped to the app's JSON import/export flows (SPEC §7). The path the
 * user picks is handed straight to a backend command (`export_*`/`import_*`)
 * which does the actual file I/O — the frontend never reads or writes the file
 * itself. Both helpers resolve `null` when the user cancels the dialog.
 */

import { open, save, type DialogFilter } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";

/** Shared filter so both dialogs default to `.json` and read as the same kind. */
const JSON_FILTER: DialogFilter = { name: "JSON", extensions: ["json"] };

/**
 * Opens a native "save file" dialog seeded with `defaultName`, filtered to JSON.
 * Returns the chosen path, or `null` if the user cancels.
 */
export async function pickJsonSavePath(
  defaultName: string,
): Promise<string | null> {
  return save({ defaultPath: defaultName, filters: [JSON_FILTER] });
}

/**
 * Opens a native "open file" dialog (single-select) filtered to JSON. Returns
 * the chosen path, or `null` if the user cancels.
 */
export async function pickJsonOpenPath(): Promise<string | null> {
  // `multiple: false` narrows the plugin's return type to `string | null`.
  return open({ multiple: false, filters: [JSON_FILTER] });
}

/**
 * Opens a native "open file" dialog for an OpenSSH client config, seeded at the
 * conventional `~/.ssh/config` so the common case is one click. No extension
 * filter — an `ssh` config file has none. Returns the chosen path, or `null` if
 * the user cancels (or the home directory can't be resolved to seed the path,
 * in which case the dialog still opens at the platform default).
 */
export async function pickSshConfigOpenPath(): Promise<string | null> {
  let defaultPath: string | undefined;
  try {
    defaultPath = await join(await homeDir(), ".ssh", "config");
  } catch {
    defaultPath = undefined;
  }
  return open({ multiple: false, defaultPath });
}

/**
 * Opens a native "save file" dialog for an SFTP download, seeded with the remote
 * file's base name (no extension filter — a downloaded file may have any type).
 * Returns the chosen local path, or `null` if the user cancels.
 */
export async function pickDownloadSavePath(
  defaultName: string,
): Promise<string | null> {
  return save({ defaultPath: defaultName });
}

/**
 * Opens a native "open file" dialog for an SFTP upload (single-select, any
 * type). Returns the chosen local path, or `null` if the user cancels.
 */
export async function pickUploadOpenPath(): Promise<string | null> {
  return open({ multiple: false });
}
