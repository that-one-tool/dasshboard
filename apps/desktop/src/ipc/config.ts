import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeChecked } from "./invoke";

/** Calls the `ping` command, which returns the backend's app version string. */
export async function ping(): Promise<string> {
  return invokeChecked<string>("ping");
}

/* ----------------------------------------------------------------------------
 * Multi-instance config sync (reload)
 *
 * Each running app instance is a separate process that caches every config
 * file (`devices.json`, `profiles.json`, `settings.json`, `known_hosts.json`)
 * in memory at startup, so a change made by another instance is invisible until
 * a reload. `reloadConfig` tells the backend to re-read those files; a Rust
 * filesystem watcher also emits `config_changed` on any on-disk change so the
 * frontend can reload automatically (see `onConfigChanged`).
 * -------------------------------------------------------------------------- */

/**
 * Re-reads every persisted config file into the backend's in-memory stores, so
 * the subsequent list/get commands serve fresh data rather than the startup
 * cache. Infallible on the backend, but wrapped like the others for a uniform
 * error shape if the IPC layer itself rejects.
 */
export async function reloadConfig(): Promise<void> {
  await invokeChecked<void>("reload_config");
}

/**
 * Subscribes to the backend's debounced `config_changed` event (another
 * instance changed a config file on disk). Returns an unlisten function.
 */
export function onConfigChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("config_changed", () => handler());
}
