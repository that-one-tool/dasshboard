import { describe, it, expect } from "vitest";
import {
  joinRemote,
  parentOf,
  formatSize,
  formatMtime,
  formatMode,
  modeToOctal,
} from "./sftpFormat";

describe("joinRemote", () => {
  it("joins under a normal directory", () => {
    expect(joinRemote("/home/j", "file.txt")).toBe("/home/j/file.txt");
  });
  it("treats root and empty base as root", () => {
    expect(joinRemote("/", "etc")).toBe("/etc");
    expect(joinRemote("", "etc")).toBe("/etc");
  });
  it("collapses a trailing slash on the base", () => {
    expect(joinRemote("/var/", "log")).toBe("/var/log");
  });
});

describe("parentOf", () => {
  it("appends /.. for resolution server-side", () => {
    expect(parentOf("/home/j")).toBe("/home/j/..");
  });
  it("maps root (and empty) to root", () => {
    expect(parentOf("/")).toBe("/");
    expect(parentOf("")).toBe("/");
  });
});

describe("formatSize", () => {
  it("shows plain bytes under 1 KiB", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
  });
  it("scales to IEC units and trims a trailing .0", () => {
    expect(formatSize(1024)).toBe("1 KiB");
    expect(formatSize(1536)).toBe("1.5 KiB");
    expect(formatSize(2 * 1024 * 1024)).toBe("2 MiB");
  });
  it("returns empty for a negative/non-finite size", () => {
    expect(formatSize(-1)).toBe("");
    expect(formatSize(NaN)).toBe("");
  });
});

describe("formatMtime", () => {
  it("formats Unix seconds as local YYYY-MM-DD HH:MM", () => {
    // Build the expected string from the same local-time getters the function
    // uses, so the assertion is timezone-independent.
    const secs = 1_700_000_000;
    const d = new Date(secs * 1000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const expected =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(formatMtime(secs)).toBe(expected);
  });
  it("returns empty when the server omitted the time", () => {
    expect(formatMtime(undefined)).toBe("");
  });
});

describe("formatMode", () => {
  it("renders permission bits as rwx triples", () => {
    expect(formatMode(0o755)).toBe("rwxr-xr-x");
    expect(formatMode(0o644)).toBe("rw-r--r--");
    expect(formatMode(0o640)).toBe("rw-r-----");
    expect(formatMode(0o000)).toBe("---------");
    expect(formatMode(0o777)).toBe("rwxrwxrwx");
  });
  it("ignores the file-type/special bits above 0o777", () => {
    // 0o41755 = a setuid dir; only the low rwx bits show here.
    expect(formatMode(0o41755)).toBe("rwxr-xr-x");
  });
  it("returns empty when mode is absent", () => {
    expect(formatMode(undefined)).toBe("");
  });
});

describe("modeToOctal", () => {
  it("renders a 3-digit octal string of the rwx bits", () => {
    expect(modeToOctal(0o755)).toBe("755");
    expect(modeToOctal(0o644)).toBe("644");
    expect(modeToOctal(0o7)).toBe("007");
    expect(modeToOctal(0o41755 & 0o777)).toBe("755");
  });
});
