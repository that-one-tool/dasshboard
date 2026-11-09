/** The device dialog's visible state: which field group and auth section
 * show, the secret inputs' hygiene, and inline field errors. */

import { t } from "../../i18n";
import type { DeviceKind } from "../../ipc";
import { requireEl } from "../../ui/dom";

const KIND_SECTIONS: Record<DeviceKind, string> = {
  ssh: "#ssh-fields",
  serial: "#serial-fields",
  localShell: "#local-shell-fields",
};

const AUTH_SECTIONS: Record<string, string> = {
  password: "#auth-password",
  key: "#auth-key",
  agent: "#auth-agent",
};

const SECRET_INPUTS = ["#device-secret", "#device-passphrase"];

/** The connection kind currently selected in the dialog. */
export function selectedKind(root: ParentNode): DeviceKind {
  const value = requireEl<HTMLInputElement>(root, "#device-kind").value;
  return value === "serial" || value === "localShell" ? value : "ssh";
}

/** Show the field group matching the selected kind, hiding the others. */
export function updateKindDisplay(root: ParentNode): void {
  showOnlySection(root, KIND_SECTIONS, selectedKind(root), "device-kind-hidden");
}

/** Show the auth section (password / key / agent) matching the checked radio,
 * hiding the others. */
export function updateAuthMethodDisplay(root: ParentNode): void {
  const method = requireEl<HTMLInputElement>(root, 'input[name="auth-method"]:checked').value;
  showOnlySection(root, AUTH_SECTIONS, method, "auth-method-hidden");
}

function showOnlySection(root: ParentNode, sections: Record<string, string>, active: string, hiddenClass: string): void {
  for (const [key, selector] of Object.entries(sections)) {
    root.querySelector(selector)?.classList.toggle(hiddenClass, key !== active);
  }
}

/** Blanks both secret inputs so no password/passphrase lingers in the DOM. */
export function clearSecretFields(root: ParentNode): void {
  secretInputs(root).forEach((input) => (input.value = ""));
}

/**
 * Sets the secret inputs' placeholder: "unchanged" when editing a saved device
 * (whose secret is never pre-filled), empty for a brand-new device.
 */
export function setSecretPlaceholder(root: ParentNode, isEditing: boolean): void {
  secretInputs(root).forEach(isEditing ? markSecretUnchanged : markSecretNew);
}

function secretInputs(root: ParentNode): HTMLInputElement[] {
  return SECRET_INPUTS.map((selector) => root.querySelector<HTMLInputElement>(selector)).filter(isInput);
}

function isInput(input: HTMLInputElement | null): input is HTMLInputElement {
  return input !== null;
}

function markSecretUnchanged(input: HTMLInputElement): void {
  input.placeholder = t("devices.field.secret.placeholder");
  input.setAttribute("autocomplete", "off");
}

function markSecretNew(input: HTMLInputElement): void {
  input.placeholder = "";
}

/** Renders per-field validation errors inline beneath their inputs. */
export function displayFieldErrors(root: ParentNode, errors: Array<{ field: string; message: string }>): void {
  clearFieldErrors(root);
  errors.forEach(({ field, message }) => showFieldError(root, field, message));
}

/** Clears every inline field-error message in the form. */
function clearFieldErrors(root: ParentNode): void {
  root.querySelectorAll(".form-group .error-text").forEach((el) => {
    el.textContent = "";
  });
}

function showFieldError(root: ParentNode, field: string, message: string): void {
  const errorText = fieldErrorText(root, field);
  if (errorText) errorText.textContent = message;
}

/** The error line of `field`'s form group (`authKeyPath` → `#device-auth-key-path`). */
function fieldErrorText(root: ParentNode, field: string): Element | null | undefined {
  const input = root.querySelector(`#device-${field.replace(/([A-Z])/g, "-$1").toLowerCase()}`);
  if (!input) return undefined;
  return input.closest(".form-group")?.querySelector(".error-text");
}
