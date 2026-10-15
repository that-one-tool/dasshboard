/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, afterEach } from "vitest";
import { setLocale } from "../../i18n";
import { paneMarkup, relabelPane } from "./paneTemplate";

function mounted(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = paneMarkup();
  return root;
}

function el<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`test: element not found: ${selector}`);
  return found;
}

describe("paneMarkup", () => {
  afterEach(() => setLocale("en"));

  it("has the header controls, the terminal and the overlay", () => {
    const root = mounted();
    for (const selector of [
      ".pane-device-select",
      ".pane-connect",
      ".pane-disconnect",
      ".pane-find",
      ".pane-save-output",
      ".pane-status-label",
      ".pane-terminal",
      ".pane-overlay",
      ".overlay-retry",
      ".overlay-cancel",
    ]) {
      expect(root.querySelector(selector), selector).not.toBeNull();
    }
  });

  it("starts with the tools disabled and the overlay hidden", () => {
    const root = mounted();
    expect(el<HTMLButtonElement>(root, ".pane-find").disabled).toBe(true);
    expect(el<HTMLButtonElement>(root, ".pane-save-output").disabled).toBe(true);
    expect(el<HTMLElement>(root, ".pane-disconnect").hidden).toBe(true);
    expect(el<HTMLElement>(root, ".pane-overlay").classList.contains("dialog-hidden")).toBe(true);
  });

  it("labels the icon buttons", () => {
    const connect = el<HTMLButtonElement>(mounted(), ".pane-connect");
    expect(connect.title).toBe("Connect");
    expect(connect.getAttribute("aria-label")).toBe("Connect");
    expect(connect.querySelector("svg")).not.toBeNull();
  });
});

describe("relabelPane", () => {
  afterEach(() => setLocale("en"));

  it("relabels every static label in the current language, keeping the icons", () => {
    const root = mounted();
    setLocale("fr");
    relabelPane(root);

    const disconnect = el<HTMLButtonElement>(root, ".pane-disconnect");
    expect(disconnect.title).toBe("Déconnecter");
    expect(disconnect.getAttribute("aria-label")).toBe("Déconnecter");
    expect(disconnect.querySelector("svg")).not.toBeNull();
    expect(el<HTMLButtonElement>(root, ".pane-connect").getAttribute("aria-label")).toBe("Connecter");
    expect(el<HTMLButtonElement>(root, ".pane-save-output").title).toBe("Enregistrer la sortie dans un fichier");
    expect(el(root, ".overlay-retry").textContent?.trim()).toBe("Réessayer");
    expect(el(root, ".overlay-cancel").textContent?.trim()).toBe("Annuler");
    expect(el(root, ".pane-device-select").getAttribute("aria-label")).toBe("Appareil à connecter");
  });
});
