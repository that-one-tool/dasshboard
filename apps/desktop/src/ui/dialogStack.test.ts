/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from "vitest";
import { consumeKey, isTopDialog, pushDialog, removeDialog } from "./dialogStack";

describe("dialogStack", () => {
  it("treats the newest open dialog as the top one", () => {
    const first = {} as Element;
    const second = {} as Element;
    pushDialog(first);
    pushDialog(second);

    expect(isTopDialog(second)).toBe(true);
    expect(isTopDialog(first)).toBe(false);

    removeDialog(second);
    expect(isTopDialog(first)).toBe(true);
    removeDialog(first);
    expect(isTopDialog(first)).toBe(false);
  });

  it("moves a dialog pushed again to the top and ignores an unknown removal", () => {
    const first = {} as Element;
    const second = {} as Element;
    pushDialog(first);
    pushDialog(second);
    pushDialog(first); // a persistent dialog shown again, re-appended on top

    expect(isTopDialog(first)).toBe(true);
    removeDialog({} as Element);
    expect(isTopDialog(first)).toBe(true);
    removeDialog(first);
    expect(isTopDialog(second)).toBe(true);
    removeDialog(second);
  });
});

describe("consumeKey", () => {
  it("stops the key from reaching the next listener on the same target", () => {
    const later = vi.fn();
    const first = (e: KeyboardEvent): void => consumeKey(e);
    document.addEventListener("keydown", first, true);
    document.addEventListener("keydown", later, true);
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    document.removeEventListener("keydown", first, true);
    document.removeEventListener("keydown", later, true);
  });
});
