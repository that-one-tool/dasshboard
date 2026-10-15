/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setLocale, t } from "../../i18n";
import { overlayForStatus } from "../overlay";
import { MAX_RECONNECT_ATTEMPTS } from "../reconnect";
import { paneMarkup } from "./paneTemplate";
import { PaneOverlay } from "./paneOverlay";

function el<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`test: element not found: ${selector}`);
  return found;
}

describe("PaneOverlay", () => {
  let root: HTMLElement;
  let overlay: PaneOverlay;

  beforeEach(() => {
    root = document.createElement("div");
    root.innerHTML = paneMarkup();
    overlay = new PaneOverlay(root);
  });
  afterEach(() => setLocale("en"));

  const isShown = (): boolean => !el(root, ".pane-overlay").classList.contains("dialog-hidden");

  it("shows an error state with Retry and no Cancel", () => {
    overlay.show(() => overlayForStatus("error", "boom"));
    expect(isShown()).toBe(true);
    expect(el(root, ".pane-overlay").classList.contains("overlay-error")).toBe(true);
    expect(el(root, ".overlay-detail").textContent).toBe("boom");
    expect(el(root, ".overlay-retry").hidden).toBe(false);
    expect(el(root, ".overlay-cancel").hidden).toBe(true);
  });

  it("a connected state hides it", () => {
    overlay.show(() => overlayForStatus("error", "boom"));
    overlay.show(() => overlayForStatus("connected"));
    expect(isShown()).toBe(false);
  });

  it("shows a reconnect attempt with a spinner and Cancel", () => {
    overlay.show(() => overlayForStatus("error", "boom"));
    overlay.showReconnecting(2);
    expect(isShown()).toBe(true);
    expect(el(root, ".pane-overlay").classList.contains("overlay-error")).toBe(false);
    expect(el(root, ".overlay-spinner").hidden).toBe(false);
    expect(el(root, ".overlay-title").textContent).toBe(t("pane.overlay.reconnecting"));
    expect(el(root, ".overlay-detail").textContent).toBe(
      t("pane.overlay.attempt", { n: 2, max: MAX_RECONNECT_ATTEMPTS }),
    );
    expect(el(root, ".overlay-retry").hidden).toBe(true);
    expect(el(root, ".overlay-cancel").hidden).toBe(false);
  });

  it("hide hides it", () => {
    overlay.showReconnecting(1);
    overlay.hide();
    expect(isShown()).toBe(false);
  });

  it("retranslate redraws the shown state in the new language", () => {
    overlay.show(() => overlayForStatus("error", t("pane.overlay.deviceGone")));
    const english = el(root, ".overlay-detail").textContent;
    setLocale("fr");
    overlay.retranslate();
    expect(el(root, ".overlay-detail").textContent).toBe(t("pane.overlay.deviceGone"));
    expect(el(root, ".overlay-detail").textContent).not.toBe(english);
  });

  it("retranslate redraws a reconnect attempt", () => {
    overlay.showReconnecting(3);
    const english = el(root, ".overlay-title").textContent;
    setLocale("fr");
    overlay.retranslate();
    expect(el(root, ".overlay-title").textContent).toBe(t("pane.overlay.reconnecting"));
    expect(el(root, ".overlay-title").textContent).not.toBe(english);
  });

  it("retranslate keeps a hidden overlay hidden", () => {
    overlay.retranslate();
    expect(isShown()).toBe(false);
  });
});
