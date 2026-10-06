/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from "vitest";
import { tabShortcut } from "./tabShortcuts";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("tabShortcut", () => {
  it("maps Ctrl+Shift+T/W and Ctrl+(Shift+)Tab everywhere", () => {
    expect(tabShortcut(key({ key: "T", ctrlKey: true, shiftKey: true }), false)).toBe("new");
    expect(tabShortcut(key({ key: "W", ctrlKey: true, shiftKey: true }), false)).toBe("close");
    expect(tabShortcut(key({ key: "Tab", ctrlKey: true }), false)).toBe("next");
    expect(tabShortcut(key({ key: "Tab", ctrlKey: true, shiftKey: true }), false)).toBe("previous");
  });

  it("works on a non-Latin layout, by the key's position", () => {
    expect(tabShortcut(key({ key: "Е", code: "KeyT", ctrlKey: true, shiftKey: true }), false)).toBe("new");
    expect(tabShortcut(key({ key: "Ц", code: "KeyW", ctrlKey: true, shiftKey: true }), false)).toBe("close");
    expect(tabShortcut(key({ key: "ц", code: "KeyW", metaKey: true }), true)).toBe("close");
  });

  it("leaves the shell's Ctrl+T / Ctrl+W alone", () => {
    expect(tabShortcut(key({ key: "t", ctrlKey: true }), false)).toBeNull();
    expect(tabShortcut(key({ key: "w", ctrlKey: true }), true)).toBeNull();
  });

  it("accepts Cmd in place of Ctrl on macOS", () => {
    expect(tabShortcut(key({ key: "T", metaKey: true, shiftKey: true }), true)).toBe("new");
    expect(tabShortcut(key({ key: "T", metaKey: true, shiftKey: true }), false)).toBeNull();
  });

  it("closes a tab on plain Cmd+W on macOS only", () => {
    expect(tabShortcut(key({ key: "w", metaKey: true }), true)).toBe("close");
    expect(tabShortcut(key({ key: "w", metaKey: true }), false)).toBeNull();
    expect(tabShortcut(key({ key: "w", metaKey: true, altKey: true }), true)).toBeNull();
  });

  it("jumps to tabs 1–8 on Ctrl+digit and to the last tab on Ctrl+9", () => {
    expect(tabShortcut(key({ key: "1", code: "Digit1", ctrlKey: true }), false)).toEqual({ jumpTo: 0 });
    expect(tabShortcut(key({ key: "8", code: "Digit8", ctrlKey: true }), false)).toEqual({ jumpTo: 7 });
    expect(tabShortcut(key({ key: "9", code: "Digit9", ctrlKey: true }), false)).toEqual({ jumpTo: "last" });
  });

  it("matches the digit by physical key, so it works where digits need Shift (AZERTY)", () => {
    expect(tabShortcut(key({ key: "&", code: "Digit1", ctrlKey: true }), false)).toEqual({ jumpTo: 0 });
  });

  it("jumps on Cmd+digit on macOS, leaving Ctrl+digit to the terminal there", () => {
    expect(tabShortcut(key({ key: "2", code: "Digit2", metaKey: true }), true)).toEqual({ jumpTo: 1 });
    expect(tabShortcut(key({ key: "2", code: "Digit2", metaKey: true }), false)).toBeNull();
    expect(tabShortcut(key({ key: "3", code: "Digit3", ctrlKey: true }), true)).toBeNull();
  });

  it("leaves Ctrl+0, Ctrl+Shift+digit and AltGr (Ctrl+Alt) digits alone", () => {
    expect(tabShortcut(key({ key: "0", code: "Digit0", ctrlKey: true }), false)).toBeNull();
    expect(tabShortcut(key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(tabShortcut(key({ key: "~", code: "Digit2", ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(tabShortcut(key({ key: "1", code: "Digit1" }), false)).toBeNull();
  });

  it("duplicates the tab on Ctrl+Shift+D, leaving the shell's Ctrl+D (EOF) alone", () => {
    expect(tabShortcut(key({ key: "D", ctrlKey: true, shiftKey: true }), false)).toBe("duplicate");
    expect(tabShortcut(key({ key: "D", metaKey: true, shiftKey: true }), true)).toBe("duplicate");
    expect(tabShortcut(key({ key: "d", ctrlKey: true }), false)).toBeNull();
  });

  it("acts once on a held Ctrl+Shift+T/W/D, but keeps repeating tab cycling and jumps", () => {
    const held = { ctrlKey: true, shiftKey: true, repeat: true };
    expect(tabShortcut(key({ key: "T", ...held }), false)).toBeNull();
    expect(tabShortcut(key({ key: "W", ...held }), false)).toBeNull();
    expect(tabShortcut(key({ key: "D", ...held }), false)).toBeNull();
    expect(tabShortcut(key({ key: "w", metaKey: true, repeat: true }), true)).toBeNull();
    expect(tabShortcut(key({ key: "Tab", ...held }), false)).toBe("previous");
    expect(tabShortcut(key({ key: "Tab", ctrlKey: true, repeat: true }), false)).toBe("next");
    expect(tabShortcut(key({ key: "1", code: "Digit1", ctrlKey: true, repeat: true }), false)).toEqual({
      jumpTo: 0,
    });
  });

  it("ignores unrelated keys", () => {
    expect(tabShortcut(key({ key: "a", ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(tabShortcut(key({ key: "constructor", ctrlKey: true }), false)).toBeNull();
  });
});
