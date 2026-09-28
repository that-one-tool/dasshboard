import { describe, it, expect } from "vitest";
import { isMacPlatform, isShortcutModifier } from "./keyboard";

const key = (mods: { ctrlKey?: boolean; metaKey?: boolean }) =>
  ({ ctrlKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe("isMacPlatform", () => {
  it("recognises the macOS WebView user agent", () => {
    expect(
      isMacPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"),
    ).toBe(true);
  });

  it("is false on Windows and Linux", () => {
    expect(isMacPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140.0")).toBe(false);
    expect(isMacPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe(false);
  });
});

describe("isShortcutModifier", () => {
  it("accepts Ctrl everywhere", () => {
    expect(isShortcutModifier(key({ ctrlKey: true }), false)).toBe(true);
    expect(isShortcutModifier(key({ ctrlKey: true }), true)).toBe(true);
  });

  it("accepts Cmd on macOS only", () => {
    expect(isShortcutModifier(key({ metaKey: true }), true)).toBe(true);
    expect(isShortcutModifier(key({ metaKey: true }), false)).toBe(false);
  });

  it("rejects a key without either modifier", () => {
    expect(isShortcutModifier(key({}), true)).toBe(false);
  });
});
