import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "./errors";

/* ----------------------------------------------------------------------------
 * Config-write echo suppression (for the multi-instance sync in `config.ts`)
 * -------------------------------------------------------------------------- */

/**
 * When THIS window last wrote config, as an epoch-ms deadline. A local write
 * lands on disk and bounces straight back through the file watcher as a
 * `config_changed` event; without this the window would pointlessly reload its
 * own change. Auto-reload consults `isLocalConfigWriteRecent()` to skip that
 * echo; the manual Reload button ignores it and always reloads.
 */
let suppressAutoReloadUntil = 0;

/** How long after a local config write to treat an incoming `config_changed`
 * as our own echo. Comfortably covers the watcher's 300 ms debounce plus the
 * OS delivering the event. */
const LOCAL_WRITE_ECHO_MS = 900;

/** Marks that this window just wrote a config file (called by every config-
 * writing IPC wrapper in `ipc/` on success), arming the echo-suppression window. */
export function markLocalConfigWrite(): void {
  suppressAutoReloadUntil = Date.now() + LOCAL_WRITE_ECHO_MS;
}

/** Whether a `config_changed` event arriving now is most likely the echo of
 * this window's own recent write, and so should not trigger an auto-reload. */
export function isLocalConfigWriteRecent(): boolean {
  return Date.now() < suppressAutoReloadUntil;
}

/* ----------------------------------------------------------------------------
 * invoke helpers
 *
 * Every command wrapper in `ipc/` funnels through one of these two helpers so the
 * `try/catch → normalizeError` shape (and, for writes, the echo-suppression
 * arm) lives in exactly one place instead of being copy-pasted per command.
 * -------------------------------------------------------------------------- */

/**
 * Invokes a backend command, normalizing any rejection to an {@link AppError}.
 * Pass no `args` for a no-argument command — the second `invoke` parameter is
 * then omitted so the wire call is a bare `invoke(cmd)`.
 */
export async function invokeChecked<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await (args === undefined ? invoke<T>(cmd) : invoke<T>(cmd, args));
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Like {@link invokeChecked}, but for a command that writes a config file: on
 * success it arms {@link markLocalConfigWrite} so the file-watcher echo of this
 * window's own write doesn't trigger a redundant auto-reload. The mark runs
 * only after the invoke resolves, so a failed write never suppresses a reload.
 */
export async function invokeMutation<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const result = await invokeChecked<T>(cmd, args);
  markLocalConfigWrite();
  return result;
}

/* ============================================================================
 * Error handling
 * ============================================================================ */

/**
 * Normalizes Tauri invoke errors to our AppError type.
 *
 * When a backend command returns Err(AppError), Tauri will reject the invoke promise
 * with the serialized error object (already in { code, message } shape). We just
 * validate and return it. If the error is a different shape (e.g., Tauri IPC error),
 * we wrap it as a generic "Io" error.
 */
function normalizeError(err: unknown): AppError {
  if (!isAppError(err)) return { code: "Io", message: String(err) };
  return { code: err.code, message: err.message };
}

function isAppError(err: unknown): err is AppError {
  const fields = asFields(err);
  return typeof fields?.code === "string" && typeof fields.message === "string";
}

function asFields(value: unknown): { code?: unknown; message?: unknown } | null {
  return typeof value === "object" ? value : null;
}
