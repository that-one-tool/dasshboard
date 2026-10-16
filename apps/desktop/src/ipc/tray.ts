import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeChecked } from "./invoke";

/* ----------------------------------------------------------------------------
 * System tray (backend `tray.rs`)
 * -------------------------------------------------------------------------- */

/** Mirrors the backend `TrayLabels`: the tray menu, already translated. */
export interface TrayLabels {
  /** The disabled live-connection count line, pluralized. */
  connections: string;
  show: string;
  quit: string;
}

/** Live shell sessions, tunnels and SFTP connections right now. */
export async function getLiveSessionCount(): Promise<number> {
  return invokeChecked<number>("live_session_count");
}

/** Pushes translated tray menu labels to the backend. */
export async function setTrayLabels(labels: TrayLabels): Promise<void> {
  await invokeChecked<void>("set_tray_labels", { labels });
}

/** Subscribes to `live_session_count` (emitted when the number of live
 * sessions, tunnels and SFTP connections changes). Returns an unlisten function. */
export function onLiveSessionCount(handler: (count: number) => void): Promise<UnlistenFn> {
  return listen<number>("live_session_count", (e) => handler(e.payload));
}
