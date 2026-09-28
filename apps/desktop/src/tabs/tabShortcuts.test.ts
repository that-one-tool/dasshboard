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

  it("ignores unrelated keys", () => {
    expect(tabShortcut(key({ key: "a", ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(tabShortcut(key({ key: "constructor", ctrlKey: true }), false)).toBeNull();
  });
});
