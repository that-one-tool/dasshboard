import { describe, it, expect } from "vitest";
import { FONT_SIZE, KEEPALIVE_COUNT, SFTP_IDLE_MINS, parseBounded } from "./settingsBounds";

describe("parseBounded", () => {
  it("keeps an in-range integer", () => {
    expect(parseBounded("20", 14, FONT_SIZE)).toBe(20);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(parseBounded("-5", 14, FONT_SIZE)).toBe(6);
    expect(parseBounded("999", 14, FONT_SIZE)).toBe(40);
    expect(parseBounded("0", 3, KEEPALIVE_COUNT)).toBe(1);
    expect(parseBounded("99999999999", 10, SFTP_IDLE_MINS)).toBe(1440);
  });

  it("falls back for a non-numeric field", () => {
    expect(parseBounded("abc", 14, FONT_SIZE)).toBe(14);
    expect(parseBounded("", 14, FONT_SIZE)).toBe(14);
  });
});
