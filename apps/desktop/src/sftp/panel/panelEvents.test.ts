/** @vitest-environment happy-dom */
import { describe, it, expect, vi } from "vitest";
import { buildPanelElements } from "./panelElements";
import { withPath, withSortKey, withTransferId, wireActionClicks, wireControlEvents } from "./panelEvents";

function setup() {
  const els = buildPanelElements(document.createElement("aside"));
  document.body.replaceChildren(els.root);
  const handlers = {
    onPathEnter: vi.fn(),
    onPathEscape: vi.fn(),
    onDeviceChange: vi.fn(),
    onFilter: vi.fn(),
  };
  const onAction = vi.fn();
  wireControlEvents(els, handlers);
  wireActionClicks(els.root, onAction);
  return { els, handlers: { ...handlers, onAction } };
}

function element(html: string, selector: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector(selector) as Element;
}

describe("panel event wiring", () => {
  it("Enter in the path input submits it without the default action", () => {
    const { els, handlers } = setup();
    els.path.value = "/var/log";
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    els.path.dispatchEvent(enter);
    expect(handlers.onPathEnter).toHaveBeenCalledWith("/var/log");
    expect(enter.defaultPrevented).toBe(true);
  });

  it("Escape in the path input resets it, leaves it, and stops there", () => {
    const { els, handlers } = setup();
    const outer = vi.fn();
    els.root.addEventListener("keydown", outer);
    els.path.focus();
    els.path.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(handlers.onPathEscape).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(els.path);
  });

  it("ignores other keys in the path input", () => {
    const { els, handlers } = setup();
    els.path.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(handlers.onPathEnter).not.toHaveBeenCalled();
    expect(handlers.onPathEscape).not.toHaveBeenCalled();
  });

  it("passes a picked device on, but not the placeholder", () => {
    const { els, handlers } = setup();
    els.deviceSelect.innerHTML = '<option value="">Pick</option><option value="a">Alpha</option>';
    els.deviceSelect.value = "";
    els.deviceSelect.dispatchEvent(new Event("change"));
    expect(handlers.onDeviceChange).not.toHaveBeenCalled();
    els.deviceSelect.value = "a";
    els.deviceSelect.dispatchEvent(new Event("change"));
    expect(handlers.onDeviceChange).toHaveBeenCalledWith("a");
  });

  it("passes the filter text on", () => {
    const { els, handlers } = setup();
    els.filter.value = "log";
    els.filter.dispatchEvent(new Event("input"));
    expect(handlers.onFilter).toHaveBeenCalledWith("log");
  });

  it("routes a click inside a data-action control, even on its SVG", () => {
    const { els, handlers } = setup();
    const svg = els.back.querySelector("svg");
    svg?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(handlers.onAction).toHaveBeenCalledWith("back", svg);
  });

  it("routes a click once per wiring of the root, not per markup build", () => {
    const { els, handlers } = setup();
    const rebuilt = buildPanelElements(els.root);
    wireControlEvents(rebuilt, { onPathEnter: vi.fn(), onPathEscape: vi.fn(), onDeviceChange: vi.fn(), onFilter: vi.fn() });
    rebuilt.back.click();
    expect(handlers.onAction).toHaveBeenCalledOnce();
  });

  it("ignores a click outside any data-action control", () => {
    const { els, handlers } = setup();
    els.status.click();
    expect(handlers.onAction).not.toHaveBeenCalled();
  });
});

describe("click target helpers", () => {
  it("withPath reads the nearest data-path", () => {
    const action = vi.fn();
    withPath(element('<span data-path="/etc"><b>x</b></span>', "b"), action);
    withPath(element("<b>x</b>", "b"), action);
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith("/etc");
  });

  it("withTransferId reads a numeric data-tx-id only", () => {
    const action = vi.fn();
    withTransferId(element('<div data-tx-id="7"><b>x</b></div>', "b"), action);
    withTransferId(element("<b>x</b>", "b"), action);
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith(7);
  });

  it("withSortKey reads a known data-sort only", () => {
    const action = vi.fn();
    withSortKey(element('<button data-sort="size">S</button>', "button"), action);
    withSortKey(element('<button data-sort="owner">O</button>', "button"), action);
    withSortKey(element("<b>x</b>", "b"), action);
    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith("size");
  });
});
