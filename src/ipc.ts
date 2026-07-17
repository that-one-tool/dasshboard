import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers around Tauri `invoke` calls.
 *
 * SPEC.md section 10 requires every IPC payload to be defined once here,
 * mirroring the Rust `serde` structs (camelCase on the wire). Phase 0 only
 * exposes `ping`; later phases add the full command surface from
 * SPEC.md section 5.
 */

/** Calls the `ping` command, which returns the backend's app version string. */
export async function ping(): Promise<string> {
  return invoke<string>("ping");
}
