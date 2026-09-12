/**
 * Reading and writing the device dialog's form DOM.
 *
 * These are pure DOM helpers over a `root` (the device manager container): they
 * read the current inputs into a `DeviceFormValues` fragment, populate the
 * inputs from a saved `Device`, toggle the SSH/serial and password/key field
 * groups, and manage the secret-field hygiene (placeholder + clearing). Kept
 * out of `deviceManager.ts` so the controller is left with event wiring and
 * backend calls, and so this DOM logic is unit-testable without the controller.
 */

import type {
  Auth,
  Device,
  DeviceKind,
  FlowControl,
  Forward,
  Parity,
} from "../ipc";
import type { DeviceFormValues } from "./validation";
import { requireEl } from "../ui/dom";

/** The connection kind currently selected in the dialog. */
export function selectedKind(root: ParentNode): DeviceKind {
  return requireEl<HTMLInputElement>(root, "#device-kind").value === "serial"
    ? "serial"
    : "ssh";
}

/** Show the SSH field group or the serial field group, per the selector. */
export function updateKindDisplay(root: ParentNode): void {
  const isSerial = selectedKind(root) === "serial";
  root
    .querySelector("#ssh-fields")
    ?.classList.toggle("device-kind-hidden", isSerial);
  root
    .querySelector("#serial-fields")
    ?.classList.toggle("device-kind-hidden", !isSerial);
}

/** Show the password or key auth section, per the checked auth-method radio. */
export function updateAuthMethodDisplay(root: ParentNode): void {
  const method = requireEl<HTMLInputElement>(
    root,
    'input[name="auth-method"]:checked',
  ).value;

  const passwordSection = root.querySelector("#auth-password");
  const keySection = root.querySelector("#auth-key");

  if (method === "password") {
    passwordSection?.classList.remove("auth-method-hidden");
    keySection?.classList.add("auth-method-hidden");
  } else {
    passwordSection?.classList.add("auth-method-hidden");
    keySection?.classList.remove("auth-method-hidden");
  }
}

/** Blanks both secret inputs so no password/passphrase lingers in the DOM. */
export function clearSecretFields(root: ParentNode): void {
  const secret = root.querySelector<HTMLInputElement>("#device-secret");
  const passphrase = root.querySelector<HTMLInputElement>("#device-passphrase");
  if (secret) secret.value = "";
  if (passphrase) passphrase.value = "";
}

/**
 * Sets the secret inputs' placeholder: "unchanged" when editing a saved device
 * (whose secret is never pre-filled), empty for a brand-new device.
 */
export function setSecretPlaceholder(root: ParentNode, isEditing: boolean): void {
  const secretInput = root.querySelector<HTMLInputElement>("#device-secret");
  const passphraseInput =
    root.querySelector<HTMLInputElement>("#device-passphrase");

  if (isEditing) {
    if (secretInput) secretInput.placeholder = "unchanged";
    if (passphraseInput) passphraseInput.placeholder = "unchanged";
    secretInput?.setAttribute("autocomplete", "off");
    passphraseInput?.setAttribute("autocomplete", "off");
  } else {
    if (secretInput) secretInput.placeholder = "";
    if (passphraseInput) passphraseInput.placeholder = "";
  }
}

/** Clears every inline field-error message in the form. */
function clearFieldErrors(root: ParentNode): void {
  root.querySelectorAll(".form-group .error-text").forEach((el) => {
    el.textContent = "";
  });
}

/** Renders per-field validation errors inline beneath their inputs. */
export function displayFieldErrors(
  root: ParentNode,
  errors: Array<{ field: string; message: string }>,
): void {
  clearFieldErrors(root);
  errors.forEach(({ field, message }) => {
    const input = root.querySelector<HTMLInputElement>(
      `#device-${field.replace(/([A-Z])/g, "-$1").toLowerCase()}`,
    );
    if (input) {
      const errorEl = input.closest(".form-group")?.querySelector(".error-text");
      if (errorEl) errorEl.textContent = message;
    }
  });
}

/** Populate every dialog input from a saved device (the edit path). */
export function populateForm(root: ParentNode, device: Device): void {
  const setInputValue = (selector: string, value: unknown) => {
    const el = root.querySelector<HTMLInputElement>(selector);
    if (el) el.value = String(value ?? "");
  };

  setInputValue("#device-name", device.name);
  setInputValue("#device-kind", device.kind);

  if (device.kind === "serial") {
    populateSerialFields(root, device, setInputValue);
  } else {
    populateSshFields(root, device, setInputValue);
  }

  const autoReconnect = root.querySelector<HTMLInputElement>(
    "#device-auto-reconnect",
  );
  if (autoReconnect) autoReconnect.checked = device.autoReconnect ?? false;

  updateKindDisplay(root);
  updateAuthMethodDisplay(root);
}

/** Fill the SSH-only inputs (host/port/username/auth) from a device. */
function populateSshFields(
  root: ParentNode,
  device: Extract<Device, { kind: "ssh" }>,
  setInputValue: (selector: string, value: unknown) => void,
): void {
  setInputValue("#device-host", device.host);
  setInputValue("#device-port", device.port);
  setInputValue("#device-username", device.username);

  if (device.auth.method === "password") {
    requireEl<HTMLInputElement>(
      root,
      'input[name="auth-method"][value="password"]',
    ).checked = true;
  } else {
    requireEl<HTMLInputElement>(
      root,
      'input[name="auth-method"][value="key"]',
    ).checked = true;
    // `device.auth` is already narrowed to the `key` variant here, so
    // `keyPath` is directly accessible — no cast needed.
    setInputValue("#device-key-path", device.auth.keyPath);
  }

  const autoStart = root.querySelector<HTMLInputElement>(
    "#device-tunnel-autostart",
  );
  if (autoStart) autoStart.checked = device.tunnelAutoStart ?? false;
}

/** Fill the serial-only inputs (port + framing) from a device. */
function populateSerialFields(
  root: ParentNode,
  device: Extract<Device, { kind: "serial" }>,
  setInputValue: (selector: string, value: unknown) => void,
): void {
  setInputValue("#device-port-name", device.portName);
  // The baud-rate select offers the classic presets; a device saved with a
  // non-standard rate (imported / hand-edited) gets that value added as an
  // option so it still selects rather than silently snapping to a preset.
  ensureBaudOption(root, device.baudRate);
  setInputValue("#device-baud-rate", device.baudRate);
  setInputValue("#device-data-bits", device.dataBits);
  setInputValue("#device-parity", device.parity);
  setInputValue("#device-stop-bits", device.stopBits);
  setInputValue("#device-flow-control", device.flowControl);
}

/** Add a one-off `<option>` for a non-preset baud rate so it can be selected. */
function ensureBaudOption(root: ParentNode, baudRate: number): void {
  const select = root.querySelector<HTMLSelectElement>("#device-baud-rate");
  if (!select) return;
  const value = String(baudRate);
  if (Array.from(select.options).some((o) => o.value === value)) return;
  const option = document.createElement("option");
  option.value = value;
  option.textContent = `${value} (custom)`;
  select.appendChild(option);
}

/**
 * Read every dialog input into a form-values object. `forwards` is supplied by
 * the caller (the forwards sub-editor lives in the controller); `secret` is
 * always read (the input is hidden, not removed, for a serial device — the save
 * path drops it via `decideSecretToSend`).
 */
export function readFormValues(
  root: ParentNode,
  editingDeviceId: string | null,
  forwards: Forward[],
): DeviceFormValues & { id: string; secret: string } {
  const form = root.querySelector<HTMLFormElement>("#device-form");
  if (!form) return { id: "", secret: "" };

  const base = {
    id: editingDeviceId ?? "",
    name: requireEl<HTMLInputElement>(form, "#device-name").value,
    autoReconnect: requireEl<HTMLInputElement>(form, "#device-auto-reconnect")
      .checked,
    secret: requireEl<HTMLInputElement>(form, "#device-secret").value,
  };

  if (selectedKind(form) === "serial") {
    return { ...base, ...readSerialValues(form) };
  }
  return { ...base, ...readSshValues(form, forwards) };
}

/** Read the SSH-only inputs into a form-values fragment. */
function readSshValues(form: ParentNode, forwards: Forward[]): DeviceFormValues {
  const authMethod = requireEl<HTMLInputElement>(
    form,
    'input[name="auth-method"]:checked',
  ).value;
  const auth: Auth =
    authMethod === "password"
      ? { method: "password" }
      : {
          method: "key",
          keyPath: requireEl<HTMLInputElement>(form, "#device-key-path").value,
        };

  return {
    kind: "ssh",
    host: requireEl<HTMLInputElement>(form, "#device-host").value,
    port: parseInt(requireEl<HTMLInputElement>(form, "#device-port").value, 10),
    username: requireEl<HTMLInputElement>(form, "#device-username").value,
    auth,
    forwards,
    tunnelAutoStart: requireEl<HTMLInputElement>(
      form,
      "#device-tunnel-autostart",
    ).checked,
  };
}

/** Read the serial-only inputs (port + framing) into a form-values fragment. */
function readSerialValues(form: ParentNode): DeviceFormValues {
  return {
    kind: "serial",
    portName: requireEl<HTMLInputElement>(form, "#device-port-name").value,
    baudRate: parseInt(
      requireEl<HTMLInputElement>(form, "#device-baud-rate").value,
      10,
    ),
    dataBits: parseInt(
      requireEl<HTMLInputElement>(form, "#device-data-bits").value,
      10,
    ),
    parity: requireEl<HTMLInputElement>(form, "#device-parity").value as Parity,
    stopBits: parseInt(
      requireEl<HTMLInputElement>(form, "#device-stop-bits").value,
      10,
    ),
    flowControl: requireEl<HTMLInputElement>(form, "#device-flow-control")
      .value as FlowControl,
  };
}

/**
 * Builds the `Device` to save from validated form values, filling kind-specific
 * defaults for completeness (validation has already run, so these defaults are
 * only a type-level backstop).
 */
export function buildDeviceFromForm(
  values: DeviceFormValues & { id: string },
): Device {
  const common = {
    id: values.id,
    name: values.name ?? "",
    autoReconnect: values.autoReconnect ?? false,
  };
  if (values.kind === "serial") {
    return {
      ...common,
      kind: "serial",
      portName: values.portName ?? "",
      baudRate: values.baudRate ?? 0,
      dataBits: values.dataBits ?? 8,
      parity: values.parity ?? "none",
      stopBits: values.stopBits ?? 1,
      flowControl: values.flowControl ?? "none",
    };
  }
  return {
    ...common,
    kind: "ssh",
    host: values.host ?? "",
    port: values.port ?? 0,
    username: values.username ?? "",
    auth: values.auth ?? { method: "password" },
    forwards: values.forwards ?? [],
    tunnelAutoStart: values.tunnelAutoStart ?? false,
  };
}
