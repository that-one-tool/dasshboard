import { invokeChecked } from "./invoke";

/* ----------------------------------------------------------------------------
 * App updates (backend `updater.rs`)
 * -------------------------------------------------------------------------- */

/** Mirrors the backend `UpdateInfo`: a newer release found by `checkUpdate`. */
export interface UpdateInfo {
  version: string;
  /** Release notes, when the release carries any. */
  notes: string | null;
  /** When the release was published (RFC 3339), when the server says. */
  pubDate: string | null;
  /** Whether this build can install the update itself (Windows, Linux
   * AppImage); `false` for a .deb/.rpm install, which links to the download
   * page instead. */
  canInstall: boolean;
  /** Whether Flatpak delivers the update; the dialog then points the user to
   * their software center instead of the download page. */
  viaFlatpak: boolean;
}

/** Asks the update server for a newer release; `null` when up to date. */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  return invokeChecked<UpdateInfo | null>("check_update");
}

/** Downloads and signature-verifies the confirmed release (`version` guards
 * against a re-check swapping it); live sessions are untouched. */
export async function downloadUpdate(version: string): Promise<void> {
  await invokeChecked<void>("download_update", { version });
}

/** Installs the downloaded release, closing live sessions first, then restarts
 * the app (on success this promise never settles). */
export async function installUpdate(version: string): Promise<void> {
  await invokeChecked<void>("install_update", { version });
}
