/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { deviceManagerMarkup } from "../deviceDialogTemplate";
import {
  clearSecretFields,
  displayFieldErrors,
  selectedKind,
  setSecretPlaceholder,
  updateAuthMethodDisplay,
  updateKindDisplay,
} from "./formDisplay";

let root: HTMLElement;

function q<T extends Element>(selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(selector);
  return found;
}

function hidden(selector: string, hiddenClass: string): boolean {
  return q(selector).classList.contains(hiddenClass);
}

beforeEach(() => {
  root = document.createElement("div");
  root.innerHTML = deviceManagerMarkup();
});

describe("kind display", () => {
  it("reads unknown kinds as ssh", () => {
    const kind = q<HTMLSelectElement>("#device-kind");
    kind.innerHTML += `<option value="weird">weird</option>`;
    kind.value = "weird";
    expect(selectedKind(root)).toBe("ssh");
  });

  it("shows only the selected kind's fields", () => {
    q<HTMLSelectElement>("#device-kind").value = "localShell";
    updateKindDisplay(root);
    expect(hidden("#local-shell-fields", "device-kind-hidden")).toBe(false);
    expect(hidden("#ssh-fields", "device-kind-hidden")).toBe(true);
    expect(hidden("#serial-fields", "device-kind-hidden")).toBe(true);
  });
});

describe("auth display", () => {
  it("shows only the checked method's section", () => {
    q<HTMLInputElement>('input[name="auth-method"][value="agent"]').checked = true;
    updateAuthMethodDisplay(root);
    expect(hidden("#auth-agent", "auth-method-hidden")).toBe(false);
    expect(hidden("#auth-password", "auth-method-hidden")).toBe(true);
    expect(hidden("#auth-key", "auth-method-hidden")).toBe(true);
  });
});

describe("secret fields", () => {
  it("clears both secrets", () => {
    q<HTMLInputElement>("#device-secret").value = "pw";
    q<HTMLInputElement>("#device-passphrase").value = "pp";
    clearSecretFields(root);
    expect(q<HTMLInputElement>("#device-secret").value).toBe("");
    expect(q<HTMLInputElement>("#device-passphrase").value).toBe("");
  });

  it("marks both secrets unchanged when editing, and blank for a new device", () => {
    setSecretPlaceholder(root, true);
    expect(q<HTMLInputElement>("#device-passphrase").placeholder).not.toBe("");
    expect(q("#device-secret").getAttribute("autocomplete")).toBe("off");
    setSecretPlaceholder(root, false);
    expect(q<HTMLInputElement>("#device-secret").placeholder).toBe("");
    expect(q<HTMLInputElement>("#device-passphrase").placeholder).toBe("");
  });

  it("tolerates missing secret inputs", () => {
    root.innerHTML = "";
    expect(() => {
      clearSecretFields(root);
      setSecretPlaceholder(root, true);
    }).not.toThrow();
  });
});

describe("displayFieldErrors", () => {
  function errorOf(selector: string): string | null | undefined {
    return q(selector).closest(".form-group")?.querySelector(".error-text")?.textContent;
  }

  it("shows each error under its field (camelCase → kebab id) and clears old ones", () => {
    displayFieldErrors(root, [{ field: "name", message: "Name needed" }]);
    expect(errorOf("#device-name")).toBe("Name needed");
    displayFieldErrors(root, [{ field: "keyPath", message: "Key needed" }]);
    expect(errorOf("#device-name")).toBe("");
    expect(errorOf("#device-key-path")).toBe("Key needed");
  });

  it("ignores an error for an unknown field", () => {
    expect(() => displayFieldErrors(root, [{ field: "nope", message: "x" }])).not.toThrow();
  });
});

describe("form display details", () => {
  it("selectedKind reflects the selector", () => {
    expect(selectedKind(root)).toBe("ssh");
    q<HTMLSelectElement>("#device-kind").value = "serial";
    expect(selectedKind(root)).toBe("serial");
    q<HTMLSelectElement>("#device-kind").value = "localShell";
    expect(selectedKind(root)).toBe("localShell");
  });

  it("updateKindDisplay toggles the SSH/serial groups", () => {
    q<HTMLSelectElement>("#device-kind").value = "serial";
    updateKindDisplay(root);
    expect(q("#ssh-fields").classList.contains("device-kind-hidden")).toBe(true);
    expect(q("#serial-fields").classList.contains("device-kind-hidden")).toBe(
      false,
    );
  });

  it("setSecretPlaceholder(true) marks the fields 'unchanged'; clearSecretFields blanks them", () => {
    setSecretPlaceholder(root, true);
    expect(q<HTMLInputElement>("#device-secret").placeholder).toBe("unchanged");

    q<HTMLInputElement>("#device-secret").value = "typed";
    q<HTMLInputElement>("#device-passphrase").value = "typed";
    clearSecretFields(root);
    expect(q<HTMLInputElement>("#device-secret").value).toBe("");
    expect(q<HTMLInputElement>("#device-passphrase").value).toBe("");
  });
});
