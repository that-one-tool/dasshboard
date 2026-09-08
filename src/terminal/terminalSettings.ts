/**
 * Terminal appearance helpers (Phase 5): the default settings and the mapping
 * from a `TerminalTheme` name to an xterm.js theme object. Pure — no DOM — so
 * the theme mapping is unit-tested in `terminalSettings.test.ts`.
 */

import type { TerminalSettings, TerminalTheme } from "../ipc";

/** Matches the backend `SettingsStore` defaults (SPEC §4). */
export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSize: 14,
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  theme: "dark",
};

/**
 * Bundled icons-only Nerd Font (see the `@font-face` in styles.css). It carries
 * only Nerd/Powerline glyphs — no ASCII, box-drawing, or CJK — so it wins
 * per-glyph for icon codepoints while all text falls through to the next family.
 */
export const ICON_FONT = '"Symbols Nerd Font Mono"';

/**
 * Guarantees the bundled icon font leads a terminal's font stack. The icon
 * fallback is an app concern, not a user preference, so it is injected at render
 * time rather than stored in settings — otherwise existing users (whose saved
 * `fontFamily` predates the bundled font) get no icon glyphs, and a user picking
 * a custom font would lose them too. Idempotent: a chain that already names the
 * icon font is returned unchanged.
 */
export function withIconFont(fontFamily: string): string {
  return fontFamily.includes(ICON_FONT) ? fontFamily : `${ICON_FONT}, ${fontFamily}`;
}

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
