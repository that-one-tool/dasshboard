import { describe, expect, it } from "vitest";
import { formatPingMessage } from "./version";

describe("formatPingMessage", () => {
  it("includes the version number reported by the backend", () => {
    expect(formatPingMessage("0.1.0")).toBe(
      "DaSSHboard backend v0.1.0 — IPC round trip OK",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(formatPingMessage("  0.1.0  ")).toBe(
      "DaSSHboard backend v0.1.0 — IPC round trip OK",
    );
  });

  it("falls back to a readable message for an empty version", () => {
    expect(formatPingMessage("")).toBe(
      "DaSSHboard: backend did not report a version",
    );
  });

  it("falls back to a readable message for a whitespace-only version", () => {
    expect(formatPingMessage("   ")).toBe(
      "DaSSHboard: backend did not report a version",
    );
  });
});
