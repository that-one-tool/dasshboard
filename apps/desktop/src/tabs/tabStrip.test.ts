/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTabButton,
  retranslateStrip,
  retranslateTabButton,
  showTabState,
  stripHtml,
  type TabButtonHandlers,
} from "./tabStrip";

let handlers: { [K in keyof TabButtonHandlers]: ReturnType<typeof vi.fn<(button: HTMLElement) => void>> };

beforeEach(() => {
  handlers = { onActivate: vi.fn(), onClose: vi.fn(), onRename: vi.fn() };
});

describe("stripHtml / retranslateStrip", () => {
  it("builds the strip and stack and re-labels them", () => {
    const root = document.createElement("div");
    root.innerHTML = stripHtml();
    expect(root.querySelector(".tab-strip-tabs")).not.toBeNull();
    expect(root.querySelector(".tab-stack")).not.toBeNull();
    const newBtn = root.querySelector<HTMLElement>(".tab-new-btn")!;
    newBtn.title = "";
    newBtn.setAttribute("aria-label", "");
    root.querySelector(".tab-strip")!.setAttribute("aria-label", "");
    retranslateStrip(root);
    expect(newBtn.title).not.toBe("");
    expect(newBtn.getAttribute("aria-label")).toBe(newBtn.title);
    expect(root.querySelector(".tab-strip")!.getAttribute("aria-label")).not.toBe("");
  });

  it("tolerates a missing strip", () => {
    expect(() => retranslateStrip(document.createElement("div"))).not.toThrow();
  });
});

describe("createTabButton", () => {
  it("shows the name as text, with badge and dot hidden", () => {
    const button = createTabButton("<b>Web</b>", handlers);
    expect(button.getAttribute("role")).toBe("tab");
    expect(button.querySelector(".tab-name")?.textContent).toBe("<b>Web</b>");
    expect(button.querySelector<HTMLElement>(".tab-badge")?.hidden).toBe(true);
    expect(button.querySelector<HTMLElement>(".tab-dirty-dot")?.hidden).toBe(true);
  });

  it("activates on click, closes from the glyph without activating", () => {
    const button = createTabButton("Web", handlers);
    button.click();
    button.querySelector<HTMLElement>(".tab-close")!.click();
    expect(handlers.onActivate).toHaveBeenCalledTimes(1);
    expect(handlers.onActivate).toHaveBeenCalledWith(button);
    expect(handlers.onClose).toHaveBeenCalledWith(button);
  });

  it("renames on double-click, except on the close glyph", () => {
    const button = createTabButton("Web", handlers);
    button.querySelector(".tab-close")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(handlers.onRename).not.toHaveBeenCalled();
    button.querySelector(".tab-name")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(handlers.onRename).toHaveBeenCalledWith(button);
  });

  it("does not rename on a double-click on the close glyph's SVG", () => {
    const button = createTabButton("Web", handlers);
    const glyph = button.querySelector(".tab-close svg *") ?? button.querySelector(".tab-close svg");
    expect(glyph).toBeInstanceOf(SVGElement);
    glyph!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(handlers.onRename).not.toHaveBeenCalled();
  });
});

describe("retranslateTabButton / showTabState", () => {
  it("re-labels the close glyph and badge", () => {
    const button = createTabButton("Web", handlers);
    const close = button.querySelector<HTMLElement>(".tab-close")!;
    const badge = button.querySelector<HTMLElement>(".tab-badge")!;
    close.title = "";
    badge.title = "";
    retranslateTabButton(button);
    expect(close.title).not.toBe("");
    expect(close.getAttribute("aria-label")).toBe(close.title);
    expect(badge.title).not.toBe("");
  });

  it("shows the badge when linked and the dot when dirty", () => {
    const button = createTabButton("Web", handlers);
    showTabState(button, { linked: true, dirty: false });
    expect(button.querySelector<HTMLElement>(".tab-badge")?.hidden).toBe(false);
    expect(button.querySelector<HTMLElement>(".tab-dirty-dot")?.hidden).toBe(true);
    showTabState(button, { linked: false, dirty: true });
    expect(button.querySelector<HTMLElement>(".tab-badge")?.hidden).toBe(true);
    expect(button.querySelector<HTMLElement>(".tab-dirty-dot")?.hidden).toBe(false);
  });

  it("tolerates a bare button", () => {
    const bare = document.createElement("button");
    expect(() => {
      retranslateTabButton(bare);
      showTabState(bare, { linked: true, dirty: true });
    }).not.toThrow();
  });
});
