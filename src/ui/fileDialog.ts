/**
 * Thin, typed wrappers over the Tauri dialog plugin's native `save`/`open`
 * pickers, scoped to the app's JSON import/export flows (SPEC §7). The path the
 * user picks is handed straight to a backend command (`export_*`/`import_*`)
 * which does the actual file I/O — the frontend never reads or writes the file
 * itself. Both helpers resolve `null` when the user cancels the dialog.
 */

import { open, save, type DialogFilter } from "@tauri-apps/plugin-dialog";

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
