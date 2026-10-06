/**
 * Pure paste-safety helpers (Phase 5). Pasting text with a newline into a shell
 * runs a line as a command (a trailing newline auto-executes; multiple lines run
 * several), so the pane confirms first. No DOM here — unit-tested in
 * `paste.test.ts`.
 */

import { tp } from "../i18n";
import { isMacPlatform, isShortcutModifier } from "../ui/keyboard";

/** Ctrl+Shift+V (Cmd+Shift+V on macOS): plain Ctrl+V stays the terminal's. */
export function isPasteShortcut(e: KeyboardEvent, mac: boolean = isMacPlatform()): boolean {
  return e.code === "KeyV" && e.shiftKey && isShortcutModifier(e, mac);
}

/** A line break as a terminal sees it: a lone CR is Enter too. */
const LINE_BREAK = /\r\n|\r|\n/;

// Every C0 control but tab, LF and CR, plus DEL and the C1 range. ESC is the
// dangerous one: a pasted `ESC[201~` ends bracketed paste early, so the rest
// runs as typed input.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Pasted text without the control characters a page can hide in a copy. */
export function sanitizePaste(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

/** True when the pasted text contains any line break (so it could auto-run). */
export function isMultilinePaste(text: string): boolean {
  return LINE_BREAK.test(text);
}

/** Number of lines the text pastes as (a single trailing line break ignored). */
export function lineCount(text: string): number {
  const trimmed = text.replace(/(\r\n|\r|\n)$/, "");
  if (trimmed === "") return text.length > 0 ? 1 : 0;
  return trimmed.split(LINE_BREAK).length;
}

/** Confirmation prompt copy for a multi-line paste. */
export function pasteConfirmMessage(text: string): string {
  return tp("pane.paste", lineCount(text));
}
