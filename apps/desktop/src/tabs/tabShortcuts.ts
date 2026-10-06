/**
 * Tab keyboard shortcuts. Shift is required on T/W/D so a shell keeps Ctrl+W
 * (delete word) / Ctrl+T (transpose) / Ctrl+D (EOF); Cmd works in place of
 * Ctrl on macOS. Plain Cmd+W also closes a tab there, as in every macOS
 * terminal — the native menu's Close Window is removed for it (`app_menu.rs`).
 */

import { isMacPlatform, isOnlyShortcutModifier, isShortcutModifier } from "../ui/keyboard";

export type TabAction = "new" | "close" | "duplicate" | "next" | "previous";

/** Show the tab at a 0-based index, or the last one (Ctrl+9, as in browsers). */
export interface TabJump {
  jumpTo: number | "last";
}

export type TabShortcut = TabAction | TabJump;

const WITH_SHIFT = new Map<string, TabAction>([
  ["t", "new"],
  ["w", "close"],
  ["d", "duplicate"],
  ["tab", "previous"],
]);
const WITHOUT_SHIFT = new Map<string, TabAction>([["tab", "next"]]);

/** Matched by physical key, so the jumps also work on layouts where the
 * digits need Shift (AZERTY). */
const JUMPS = new Map<string, TabJump>([
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): [string, TabJump] => [`Digit${n}`, { jumpTo: n - 1 }]),
  ["Digit9", { jumpTo: "last" }],
]);

/** A held key repeats ~30 times a second: these act once per press (each
 * duplicate connects every pane of the tab). */
const ONCE_PER_PRESS = new Set<TabShortcut | null>(["new", "close", "duplicate"]);

export function tabShortcut(e: KeyboardEvent, mac: boolean = isMacPlatform()): TabShortcut | null {
  const shortcut = tabJump(e, mac) ?? tabAction(e, mac);
  return e.repeat && ONCE_PER_PRESS.has(shortcut) ? null : shortcut;
}

/** On macOS only Cmd jumps: Ctrl+digit stays the terminal's there (Ctrl+3 is
 * Esc, Ctrl+5 the telnet escape …). */
function tabJump(e: KeyboardEvent, mac: boolean): TabJump | null {
  return isOnlyShortcutModifier(e, mac) ? (JUMPS.get(e.code) ?? null) : null;
}

function tabAction(e: KeyboardEvent, mac: boolean): TabAction | null {
  if (isPlainCmdW(e, mac)) return "close";
  return isShortcutModifier(e, mac) ? keyAction(e) : null;
}

function keyAction(e: KeyboardEvent): TabAction | null {
  const table = e.shiftKey ? WITH_SHIFT : WITHOUT_SHIFT;
  return table.get(e.key.toLowerCase()) ?? null;
}

function isPlainCmdW(e: KeyboardEvent, mac: boolean): boolean {
  return mac && isOnlyShortcutModifier(e, mac) && e.key.toLowerCase() === "w";
}
