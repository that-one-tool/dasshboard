import { invokeChecked, invokeMutation } from "./invoke";

/* ============================================================================
 * Settings types & commands (SPEC §4–5, Phase 5)
 * ============================================================================ */

export type TerminalTheme = "dark" | "light";

/** Terminal appearance, applied live to every terminal (SPEC §7). */
export interface TerminalSettings {
  fontSize: number;
  fontFamily: string;
  theme: TerminalTheme;
  /** Lines of scrollback xterm.js retains above the viewport (backend clamps
   * 0..=100000). Applied live to existing terminals and to new ones. */
  scrollback: number;
}

/** SSH keepalive settings (backend clamps interval 0..=3600, count 1..=10). */
export interface KeepaliveSettings {
  /** Seconds between keepalive pings; `0` disables keepalive. */
  intervalSecs: number;
  /** Consecutive unanswered pings before the connection is dropped. */
  countMax: number;
}

/** SFTP browser behavior (backend clamps idle-disconnect 0..=1440). */
export interface SftpSettings {
  /** Minutes an idle (collapsed) SFTP connection lives before it is
   * auto-disconnected; `0` disables the idle timeout. */
  idleDisconnectMins: number;
  /** Command that opens a file for edit-in-place (`{file}` marks the path,
   * else it is appended); empty uses the OS default app. Trimmed by the
   * backend. */
  editorCommand: string;
}

/** The whole `settings.json` payload (SPEC §4). */
export interface Settings {
  version: number;
  terminal: TerminalSettings;
  /** Id of the last-used profile, reloaded on start when no default profile is
   * set; null until a profile has been loaded at least once. */
  lastProfileId: string | null;
  /** UI language locale code (e.g. `"en"`, `"fr"`); `null` means "follow the
   * operating system", resolved by the frontend at startup (see `i18n`). */
  language: string | null;
  /** SSH keepalive cadence + dead-peer threshold, applied to shell sessions and
   * tunnels (not serial). */
  keepalive: KeepaliveSettings;
  /** SFTP file-browser behavior (idle-disconnect timeout). */
  sftp: SftpSettings;
  /** Update-check behavior (launch check is opt-in). */
  updates: UpdateSettings;
  /** System-tray behavior (close-to-tray is opt-in). */
  tray: TraySettings;
}

/** Mirrors the backend `TraySettings`. */
export interface TraySettings {
  /** Closing the window hides it to the tray (sessions keep running); off by
   * default. */
  closeToTray: boolean;
}

/** Mirrors the backend `UpdateSettings`. */
export interface UpdateSettings {
  /** Check for a new version once at app start; off by default. */
  checkOnLaunch: boolean;
}

/** Current app settings (SPEC §5). */
export async function getSettings(): Promise<Settings> {
  return invokeChecked<Settings>("get_settings");
}

/** Persists app settings (backend clamps font size / defaults empty family). */
export async function saveSettings(settings: Settings): Promise<Settings> {
  return invokeMutation<Settings>("save_settings", { settings });
}
