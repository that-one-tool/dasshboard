/**
 * Terminal appearance helpers (Phase 5): the default settings and the mapping
 * from a `TerminalTheme` name to an xterm.js theme object. Pure — no DOM — so
 * the theme mapping is unit-tested in `terminalSettings.test.ts`.
 */

import type { TerminalSettings, TerminalTheme } from "../ipc";

/** Matches the backend `SettingsStore` defaults (SPEC §4). */
export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSize: 14,
  // Icon font first (icons-only, no ASCII) so Nerd/Powerline glyphs win per-glyph
  // and text falls through to Cascadia; see DEFAULT_FONT_FAMILY in settings.rs.
  fontFamily: '"Symbols Nerd Font Mono", "Cascadia Mono", Consolas, monospace',
  theme: "dark",
};

/** xterm.js theme colors for each named theme. */
export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
}

const DARK: XtermTheme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
};

const LIGHT: XtermTheme = {
  background: "#ffffff",
  foreground: "#1e1e1e",
  cursor: "#1e1e1e",
};

export function xtermThemeFor(theme: TerminalTheme): XtermTheme {
  return theme === "light" ? LIGHT : DARK;
}
