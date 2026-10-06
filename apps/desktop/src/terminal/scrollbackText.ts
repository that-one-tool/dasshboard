/**
 * "Save output": a terminal's scrollback + screen as plain text, and the file
 * name the save dialog suggests for it.
 */

/** The slice of xterm's `IBufferLine` read here. */
export interface TextLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): { getChars(): string } | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** The slice of xterm's `IBuffer` read here (kept narrow so tests can fake it). */
export interface TextBuffer {
  readonly length: number;
  getLine(y: number): TextLine | undefined;
}

/** The buffer's text, one line per logical line (wrapped rows rejoined). */
export function bufferText(buffer: TextBuffer): string {
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    appendRow(lines, buffer, y);
  }
  const text = lines.join("\n").trimEnd();
  return text ? `${text}\n` : "";
}

function appendRow(lines: string[], buffer: TextBuffer, y: number): void {
  const row = buffer.getLine(y);
  if (!row) return;
  const text = rowText(row, buffer.getLine(y + 1)?.isWrapped === true);
  pushRow(lines, text, row.isWrapped);
}

/** A row that wraps on keeps its trailing spaces (part of the line), but not
 * the never-written cells left where a wide character didn't fit. */
function rowText(row: TextLine, wrapsOn: boolean): string {
  if (!wrapsOn) return row.translateToString(true);
  return row.translateToString(false, 0, writtenEnd(row));
}

/** The column after the last written cell. */
function writtenEnd(row: TextLine): number {
  let end = row.length;
  while (end > 0 && row.getCell(end - 1)?.getChars() === "") end--;
  return end;
}

function pushRow(lines: string[], text: string, continuesPrevious: boolean): void {
  if (continuesPrevious && lines.length > 0) lines[lines.length - 1] += text;
  else lines.push(text);
}

// Characters Windows (the strictest) refuses in a file name, plus controls.
const UNSAFE_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** `<device>-YYYY-MM-DD-HHmm.txt`, in local time. */
export function outputFileName(deviceName: string, at: Date): string {
  const base = deviceName.replace(UNSAFE_FILE_CHARS, "-") || "terminal";
  return `${base}-${localStamp(at)}.txt`;
}

function localStamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}
