/**
 * Tab keyboard shortcuts. Shift is required on T/W so a shell keeps Ctrl+W
 * (delete word) / Ctrl+T (transpose); Cmd works in place of Ctrl on macOS.
 * Plain Cmd+W also closes a tab there, as in every macOS terminal — the native
 * menu's Close Window is removed for it (`app_menu.rs`).
 */

import { isMacPlatform, isShortcutModifier } from "../ui/keyboard";

export type TabShortcut = "new" | "close" | "next" | "previous";

const WITH_SHIFT = new Map<string, TabShortcut>([
  ["t", "new"],
  ["w", "close"],
  ["tab", "previous"],
]);
const WITHOUT_SHIFT = new Map<string, TabShortcut>([["tab", "next"]]);

export function tabShortcut(e: KeyboardEvent, mac: boolean = isMacPlatform()): TabShortcut | null {
  if (mac && isPlainCmdW(e)) return "close";
  if (!isShortcutModifier(e, mac)) return null;
  const table = e.shiftKey ? WITH_SHIFT : WITHOUT_SHIFT;
  return table.get(e.key.toLowerCase()) ?? null;
}

function isPlainCmdW(e: KeyboardEvent): boolean {
  const onlyCmd = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  return onlyCmd && e.key.toLowerCase() === "w";
}
