import { describe, it, expect } from "vitest";
import { bufferText, outputFileName, type TextBuffer } from "./scrollbackText";

/** A buffer of fixed-width rows; `wrapped` marks rows continuing the previous
 * one. Cells past a row's text are empty (never written), as in xterm. */
function buffer(rows: { text: string; wrapped?: boolean }[], width = 10): TextBuffer {
  return {
    length: rows.length,
    getLine: (y) => {
      const row = rows[y];
      if (!row) return undefined;
      const padded = row.text.padEnd(width, " ");
      return {
        isWrapped: row.wrapped ?? false,
        length: width,
        getCell: (x) => (x < width ? { getChars: () => row.text[x] ?? "" } : undefined),
        translateToString: (trimRight?: boolean, start = 0, end = width) => {
          const text = padded.slice(start, end);
          return trimRight ? text.trimEnd() : text;
        },
      };
    },
  };
}

describe("bufferText", () => {
  it("joins rows with newlines, trimming trailing spaces", () => {
    expect(bufferText(buffer([{ text: "$ ls" }, { text: "a  b" }]))).toBe("$ ls\na  b\n");
  });

  it("rejoins a wrapped line, keeping a space that fell on the wrap", () => {
    const rows = [{ text: "echo the " }, { text: "end", wrapped: true }];
    expect(bufferText(buffer(rows, 9))).toBe("echo the end\n");
  });

  it("drops the empty cell left where a wide character wrapped", () => {
    const rows = [{ text: "abcd" }, { text: "中文x", wrapped: true }];
    expect(bufferText(buffer(rows, 5))).toBe("abcd中文x\n");
  });

  it("reads a real xterm buffer the same way", async () => {
    const { Terminal } = await import("@xterm/xterm");
    const terminal = new Terminal({ cols: 5, rows: 4, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write("abcd中文x\r\nok", resolve));
    expect(bufferText(terminal.buffer.normal)).toBe("abcd中文x\nok\n");
    terminal.dispose();
  });

  it("drops the empty rows below the last output", () => {
    expect(bufferText(buffer([{ text: "$" }, { text: "" }, { text: "" }]))).toBe("$\n");
  });

  it("is empty for an empty buffer", () => {
    expect(bufferText(buffer([{ text: "" }]))).toBe("");
  });
});

describe("outputFileName", () => {
  const at = new Date(2026, 9, 5, 9, 7);

  it("names the file after the device and the local time", () => {
    expect(outputFileName("NAS", at)).toBe("NAS-2026-10-05-0907.txt");
  });

  it("replaces characters a file name can't hold", () => {
    expect(outputFileName('web/01: "prod"', at)).toBe("web-01- -prod--2026-10-05-0907.txt");
  });

  it("falls back to a generic name without a device", () => {
    expect(outputFileName("", at)).toBe("terminal-2026-10-05-0907.txt");
  });
});
