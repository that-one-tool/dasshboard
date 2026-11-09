/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  cancelOnEscape,
  createDialogRoot,
  focusAction,
  setText,
  showModal,
  type ModalBehaviour,
} from "./modalDialog";

afterEach(() => {
  // Answer every dialog a test left open, so none stays in the dialog stack.
  document.querySelectorAll(".dialog-overlay").forEach((overlay) => {
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  document.body.innerHTML = "";
});

const BUTTONS = `
  <div class="dialog-overlay"></div>
  <button type="button" data-action="cancel">Cancel</button>
  <button type="button" data-action="ok">OK</button>
  <span class="other">text</span>
`;

function open(behaviour: Partial<ModalBehaviour<string | null>> = {}) {
  const root = createDialogRoot("test-dialog", BUTTONS);
  const result = showModal<string | null>(root, {
    cancelValue: null,
    actions: { ok: () => "ok" },
    focus: focusAction("ok"),
    ...behaviour,
  });
  return { root, result };
}

function clickOn(root: HTMLElement, selector: string): void {
  root.querySelector(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function pressOn(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("createDialogRoot", () => {
  it("builds a modal dialog root with the given class and markup", () => {
    const root = createDialogRoot("x-dialog", "<p>hi</p>");
    expect(root.className).toBe("dialog x-dialog");
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-modal")).toBe("true");
    expect(root.querySelector("p")?.textContent).toBe("hi");
  });
});

describe("setText", () => {
  it("sets text without parsing markup and ignores a missing element", () => {
    const root = createDialogRoot("x", "<p></p>");
    setText(root, "p", "<b>bold</b>");
    setText(root, ".missing", "nothing");
    expect(root.querySelector("p")?.textContent).toBe("<b>bold</b>");
    expect(root.querySelector("b")).toBeNull();
  });
});

describe("showModal", () => {
  it("shows the dialog and focuses the requested element", () => {
    const { root } = open();
    expect(document.body.contains(root)).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('[data-action="ok"]'));
  });

  it("resolves an action's answer, removes the dialog and restores focus", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { root, result } = open();
    clickOn(root, '[data-action="ok"]');
    await expect(result).resolves.toBe("ok");
    expect(document.body.contains(root)).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("resolves the cancel value for the cancel button and the overlay", async () => {
    const first = open();
    clickOn(first.root, '[data-action="cancel"]');
    await expect(first.result).resolves.toBeNull();
    const second = open();
    clickOn(second.root, ".dialog-overlay");
    await expect(second.result).resolves.toBeNull();
  });

  it("ignores clicks that are not on an action", async () => {
    const { root, result } = open({ actions: { ok: () => "ok", toString: () => "own" } });
    clickOn(root, ".other");
    root.dispatchEvent(new MouseEvent("click"));
    expect(document.body.contains(root)).toBe(true);
    clickOn(root, '[data-action="ok"]');
    await expect(result).resolves.toBe("ok");
  });

  it("answers a document key only in the newest dialog, and consumes it", async () => {
    const below = open({ keyResult: cancelOnEscape(null) });
    const above = open({ keyResult: cancelOnEscape(null) });
    const event = pressOn(document, "Escape");
    await expect(above.result).resolves.toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(document.body.contains(below.root)).toBe(true);
    pressOn(document, "Escape");
    await expect(below.result).resolves.toBeNull();
  });

  it("stops listening for document keys once closed", async () => {
    const seen: string[] = [];
    const { root, result } = open({
      keyResult: (e) => {
        seen.push(e.key);
        return undefined;
      },
    });
    clickOn(root, '[data-action="ok"]');
    await result;
    pressOn(document, "a");
    expect(seen).toEqual([]);
  });
});

describe("cancelOnEscape", () => {
  it("answers the cancel value on Escape only", () => {
    const keyResult = cancelOnEscape(false);
    expect(keyResult(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
    expect(keyResult(new KeyboardEvent("keydown", { key: "Enter" }))).toBeUndefined();
  });
});
