/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the device-dialog form helpers, driven against the real
 * dialog markup (`deviceManagerMarkup`) but without the controller: reading the
 * inputs into values, populating them from a device, the field-group toggles,
 * and the pure `buildDeviceFromForm` mapping.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Device } from "../ipc";
import { deviceManagerMarkup } from "./deviceDialogTemplate";
import {
  buildDeviceFromForm,
  clearSecretFields,
  populateForm,
  readFormValues,
  selectedKind,
  setSecretPlaceholder,
  updateKindDisplay,
} from "./deviceForm";

let root: HTMLElement;

function q<T extends Element>(selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}

beforeEach(() => {
  root = document.createElement("div");
  root.innerHTML = deviceManagerMarkup();
});

describe("readFormValues", () => {
  it("reads SSH inputs (password auth) into a values object", () => {
    q<HTMLInputElement>("#device-name").value = "NAS";
    q<HTMLInputElement>("#device-host").value = "10.0.0.1";
    q<HTMLInputElement>("#device-port").value = "2222";
    q<HTMLInputElement>("#device-username").value = "root";
    q<HTMLInputElement>("#device-secret").value = "hunter2";

    const values = readFormValues(root, "dev-1", []);

    expect(values).toMatchObject({
      id: "dev-1",
      kind: "ssh",
      name: "NAS",
      host: "10.0.0.1",
      port: 2222,
      username: "root",
      auth: { method: "password" },
      secret: "hunter2",
      forwards: [],
    });
  });

  it("reads the key path when key auth is selected", () => {
    q<HTMLInputElement>('input[name="auth-method"][value="key"]').checked = true;
    q<HTMLInputElement>("#device-key-path").value = "C:/keys/id_ed25519";

    const values = readFormValues(root, "", []);

    expect(values.auth).toEqual({
      method: "key",
      keyPath: "C:/keys/id_ed25519",
    });
  });

  it("reads serial inputs when the kind is serial", () => {
    q<HTMLSelectElement>("#device-kind").value = "serial";
    q<HTMLInputElement>("#device-port-name").value = "COM7";
    q<HTMLSelectElement>("#device-baud-rate").value = "9600";

    const values = readFormValues(root, "", []);

    expect(values).toMatchObject({
      kind: "serial",
      portName: "COM7",
      baudRate: 9600,
    });
  });

  it("uses an empty id/secret when the form is absent", () => {
    const empty = document.createElement("div");
    expect(readFormValues(empty, "ignored", [])).toEqual({ id: "", secret: "" });
  });
});

describe("populateForm", () => {
  it("fills SSH fields and shows the SSH group", () => {
    const device: Device = {
      id: "dev-1",
      name: "Alpha",
      kind: "ssh",
      host: "10.0.0.9",
      port: 22,
      username: "alpha",
      auth: { method: "key", keyPath: "C:/k" },
      forwards: [],
      tunnelAutoStart: true,
      autoReconnect: true,
    };

    populateForm(root, device);

    expect(q<HTMLInputElement>("#device-name").value).toBe("Alpha");
    expect(q<HTMLInputElement>("#device-host").value).toBe("10.0.0.9");
    expect(q<HTMLInputElement>("#device-key-path").value).toBe("C:/k");
    expect(
      q<HTMLInputElement>('input[name="auth-method"][value="key"]').checked,
    ).toBe(true);
    expect(q<HTMLInputElement>("#device-tunnel-autostart").checked).toBe(true);
    expect(q<HTMLInputElement>("#device-auto-reconnect").checked).toBe(true);
    expect(
      q("#serial-fields").classList.contains("device-kind-hidden"),
    ).toBe(true);
  });

  it("adds a custom baud option for a non-preset rate", () => {
    const device: Device = {
      id: "dev-2",
      name: "Odd",
      kind: "serial",
      portName: "COM3",
      baudRate: 12345,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      autoReconnect: false,
    };

    populateForm(root, device);

    const select = q<HTMLSelectElement>("#device-baud-rate");
    expect(select.value).toBe("12345");
    expect(Array.from(select.options).some((o) => o.value === "12345")).toBe(
      true,
    );
  });
});

describe("field-group and secret helpers", () => {
  it("selectedKind reflects the selector", () => {
    expect(selectedKind(root)).toBe("ssh");
    q<HTMLSelectElement>("#device-kind").value = "serial";
    expect(selectedKind(root)).toBe("serial");
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

describe("buildDeviceFromForm", () => {
  it("maps SSH values to an SSH device", () => {
    const device = buildDeviceFromForm({
      id: "dev-1",
      kind: "ssh",
      name: "NAS",
      host: "10.0.0.1",
      port: 22,
      username: "root",
      auth: { method: "password" },
      forwards: [],
      tunnelAutoStart: false,
      autoReconnect: false,
    });
    expect(device).toMatchObject({ kind: "ssh", host: "10.0.0.1", port: 22 });
  });

  it("maps serial values and fills framing defaults", () => {
    const device = buildDeviceFromForm({
      id: "dev-2",
      kind: "serial",
      name: "Arduino",
      portName: "COM3",
      baudRate: 9600,
      autoReconnect: false,
    });
    expect(device).toMatchObject({
      kind: "serial",
      portName: "COM3",
      baudRate: 9600,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
    });
  });
});
