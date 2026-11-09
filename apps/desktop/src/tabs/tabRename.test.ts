/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { startRename } from "./tabRename";

let button: HTMLElement;
let onRename: ReturnType<typeof vi.fn<(next: string) => void>>;

beforeEach(() => {
  document.body.innerHTML = `<button class="tab"><span class="tab-name">Old</span></button>`;
  button = document.querySelector(".tab")!;
  onRename = vi.fn<(next: string) => void>();
});

function input(): HTMLInputElement | null {
  return button.querySelector<HTMLInputElement>(".tab-rename-input");
}

function nameEl(): HTMLElement {
  return button.querySelector<HTMLElement>(".tab-name")!;
}

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  input()!.dispatchEvent(event);
  return event;
}

describe("startRename", () => {
  it("swaps the label for a focused, prefilled input", () => {
    startRename(button, "Old", onRename);
    expect(nameEl().hidden).toBe(true);
    expect(input()?.value).toBe("Old");
    expect(document.activeElement).toBe(input());
    expect(input()?.getAttribute("aria-label")).toBeTruthy();
  });

  it("commits a trimmed new name on Enter", () => {
    startRename(button, "Old", onRename);
    input()!.value = "  New  ";
    const event = press("Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(onRename).toHaveBeenCalledWith("New");
    expect(nameEl().textContent).toBe("New");
    expect(nameEl().hidden).toBe(false);
    expect(input()).toBeNull();
  });

  it("commits on blur, once", () => {
    startRename(button, "Old", onRename);
    const field = input()!;
    field.value = "New";
    field.dispatchEvent(new Event("blur"));
    field.dispatchEvent(new Event("blur"));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape and ignores other keys", () => {
    startRename(button, "Old", onRename);
    input()!.value = "New";
    expect(press("a").defaultPrevented).toBe(false);
    expect(input()).not.toBeNull();
    press("Escape");
    expect(onRename).not.toHaveBeenCalled();
    expect(nameEl().textContent).toBe("Old");
  });

  it("ignores an empty or unchanged name", () => {
    startRename(button, "Old", onRename);
    input()!.value = "   ";
    press("Enter");
    startRename(button, "Old", onRename);
    press("Enter");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("keeps pointer events inside the input", () => {
    const clicks = vi.fn();
    button.addEventListener("click", clicks);
    startRename(button, "Old", onRename);
    input()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicks).not.toHaveBeenCalled();
  });

  it("does not start twice, nor without a label", () => {
    startRename(button, "Old", onRename);
    startRename(button, "Old", onRename);
    expect(button.querySelectorAll(".tab-rename-input")).toHaveLength(1);
    const bare = document.createElement("button");
    startRename(bare, "x", onRename);
    expect(bare.children).toHaveLength(0);
  });
});
