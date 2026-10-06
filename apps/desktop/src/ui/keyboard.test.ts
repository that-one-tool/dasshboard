import { describe, it, expect } from "vitest";
import { heldModifiers, isMacPlatform, isOnlyShortcutModifier, isShortcutModifier } from "./keyboard";

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

describe("heldModifiers", () => {
  it("lists the modifiers held, in a fixed order", () => {
    const e = { ctrlKey: true, altKey: false, shiftKey: true, metaKey: false } as KeyboardEvent;
    expect(heldModifiers(e)).toBe("ctrlKey+shiftKey");
    expect(heldModifiers({ ...e, ctrlKey: false, shiftKey: false } as KeyboardEvent)).toBe("");
  });
});

describe("isOnlyShortcutModifier", () => {
  const key = (mods: Partial<KeyboardEvent>) =>
    ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

  it("is Ctrl alone elsewhere, Cmd alone on macOS", () => {
    expect(isOnlyShortcutModifier(key({ ctrlKey: true }), false)).toBe(true);
    expect(isOnlyShortcutModifier(key({ metaKey: true }), true)).toBe(true);
    expect(isOnlyShortcutModifier(key({ ctrlKey: true }), true)).toBe(false);
    expect(isOnlyShortcutModifier(key({ metaKey: true }), false)).toBe(false);
  });

  it("is false with any other modifier held (Shift, or Alt: Ctrl+Alt is AltGr)", () => {
    expect(isOnlyShortcutModifier(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isOnlyShortcutModifier(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isOnlyShortcutModifier(key({ metaKey: true, ctrlKey: true }), true)).toBe(false);
  });
});
