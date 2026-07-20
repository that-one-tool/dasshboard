/**
 * Pure paste-safety helpers (Phase 5). Pasting text with a newline into a shell
 * runs a line as a command (a trailing newline auto-executes; multiple lines run
 * several), so the pane confirms first. No DOM here — unit-tested in
 * `paste.test.ts`.
 */

/** True when the pasted text contains any newline (so it could auto-run). */
export function isMultilinePaste(text: string): boolean {
  return /\r?\n/.test(text);
}

/** Number of lines the text pastes as (a single trailing newline ignored). */
export function lineCount(text: string): number {
  const trimmed = text.replace(/\r?\n$/, "");
  if (trimmed === "") return text.length > 0 ? 1 : 0;
  return trimmed.split(/\r?\n/).length;
}

/** Confirmation prompt copy for a multi-line paste. */
export function pasteConfirmMessage(text: string): string {
  const n = lineCount(text);
  return `Paste ${n} line${n === 1 ? "" : "s"} into the terminal? Each line may run as a command.`;
}
