import { describe, it, expect } from "vitest";
import { isMultilinePaste, lineCount, pasteConfirmMessage } from "./paste";

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
});

describe("lineCount", () => {
  it("counts content lines, ignoring one trailing newline", () => {
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("")).toBe(0);
  });
});

describe("pasteConfirmMessage", () => {
  it("pluralizes and includes the line count", () => {
    expect(pasteConfirmMessage("a\nb")).toContain("2 lines");
    expect(pasteConfirmMessage("a\n")).toContain("1 line");
  });
});
