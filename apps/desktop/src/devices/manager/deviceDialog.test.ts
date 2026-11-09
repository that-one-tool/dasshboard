/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Device } from "../../ipc";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { deviceManagerMarkup } from "../deviceDialogTemplate";
import { DeviceDialog } from "./deviceDialog";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function sshDevice(id: string, name: string, extra: Partial<Device> = {}): Device {
  return {
    id, name, kind: "ssh", host: `${id}.lan`, port: 22, username: "me",
    auth: { method: "password" }, forwards: [], tunnelAutoStart: false, proxyJump: null,
    forwardAgent: false, x11Forwarding: "off", autoReconnect: false, tags: [], connectSnippet: null,
    ...extra,
  } as Device;
}

const serial = {
  id: "s", name: "Arduino", kind: "serial", portName: "COM3", baudRate: 115200, dataBits: 8,
  parity: "none", stopBits: 1, flowControl: "none", autoReconnect: false, tags: [], connectSnippet: null,
} as Device;

const forward = { id: "f1", name: "db", kind: "local", localAddr: "127.0.0.1", localPort: 8080, remoteHost: "db", remotePort: 5432 };
const alpha = sshDevice("a", "Alpha", { forwards: [forward] } as Partial<Device>);
const bravo = sshDevice("b", "Bravo");

let container: HTMLElement;
let dialog: DeviceDialog;

function el<T extends Element>(selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(selector);
  return found;
}

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(true);
  document.body.innerHTML = `<div class="device-list">${deviceManagerMarkup()}</div>`;
  container = document.body.firstElementChild as HTMLElement;
  dialog = new DeviceDialog(container);
  dialog.attach();
});

describe("DeviceDialog.open", () => {
  it("opens a blank form for a new device, focused on the name", () => {
    el<HTMLInputElement>("#device-name").value = "leftover";
    dialog.open(null, [alpha]);
    expect(el("#device-dialog").classList.contains("dialog-hidden")).toBe(false);
    expect(el("#device-dialog").getAttribute("aria-hidden")).toBe("false");
    expect(el("#device-dialog-title").textContent).toBe("Add Device");
    expect(el<HTMLInputElement>("#device-name").value).toBe("");
    expect(document.activeElement).toBe(el("#device-name"));
  });

  it("fills the form of an existing device", () => {
    dialog.open("a", [alpha, bravo]);
    expect(el("#device-dialog-title").textContent).toBe("Edit Device");
    expect(el<HTMLInputElement>("#device-name").value).toBe("Alpha");
    expect(dialog.readValidValues()?.forwards).toHaveLength(1);
  });

  it("stays closed when the device is gone", () => {
    dialog.open("missing", [alpha]);
    expect(el("#device-dialog").classList.contains("dialog-hidden")).toBe(true);
  });

  it("offers the other SSH devices as jump hosts", () => {
    dialog.open("a", [alpha, bravo, serial]);
    const options = [...el<HTMLSelectElement>("#device-proxy-jump").options].map((o) => o.value);
    expect(options).toEqual(["", "b"]);
  });

  it("shows the agent hint only when no agent is reachable", async () => {
    invokeMock.mockResolvedValue(false);
    dialog.open(null, []);
    await flush();
    expect(el<HTMLElement>(".device-agent-unavailable").hidden).toBe(false);
    invokeMock.mockRejectedValue(new Error("probe failed"));
    dialog.open(null, []);
    await flush();
    expect(el<HTMLElement>(".device-agent-unavailable").hidden).toBe(true);
  });

  it("does nothing without the dialog markup", () => {
    container.innerHTML = "";
    expect(() => dialog.open(null, [])).not.toThrow();
  });
});

describe("DeviceDialog.close", () => {
  it("hides the dialog and clears the secret", () => {
    dialog.open("a", [alpha]);
    el<HTMLInputElement>("#device-secret").value = "pw";
    dialog.close();
    expect(el("#device-dialog").classList.contains("dialog-hidden")).toBe(true);
    expect(el("#device-dialog").getAttribute("aria-hidden")).toBe("true");
    expect(el<HTMLInputElement>("#device-secret").value).toBe("");
  });

  it("closes on Escape and on a close control, but not on a click inside it", () => {
    dialog.open(null, []);
    el("#device-dialog").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(el("#device-dialog").classList.contains("dialog-hidden")).toBe(true);
    dialog.open(null, []);
    const close = el<HTMLElement>(".dialog-close-btn");
    close.firstElementChild?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(el("#device-dialog").classList.contains("dialog-hidden")).toBe(false);
    close.click();
    expect(el("#device-dialog").classList.contains("dialog-hidden")).toBe(true);
  });

  it("does not throw without the dialog markup", () => {
    container.innerHTML = "";
    expect(() => dialog.close()).not.toThrow();
  });
});

describe("DeviceDialog.readValidValues", () => {
  it("returns null and shows errors for an invalid form", () => {
    dialog.open(null, []);
    expect(dialog.readValidValues()).toBeNull();
    const shown = [...container.querySelectorAll(".error-text")].filter((e) => e.textContent !== "");
    expect(shown.length).toBeGreaterThan(0);
  });

  it("returns the values with the edited device id", () => {
    dialog.open("b", [bravo]);
    expect(dialog.readValidValues()).toMatchObject({ id: "b", name: "Bravo" });
  });

  it("swaps the auth section with the auth method", () => {
    dialog.open(null, []);
    const key = el<HTMLInputElement>('input[name="auth-method"][value="key"]');
    key.checked = true;
    key.dispatchEvent(new Event("change"));
    expect(el("#auth-key").classList.contains("auth-method-hidden")).toBe(false);
    expect(el("#auth-password").classList.contains("auth-method-hidden")).toBe(true);
  });

  it("swaps the field groups with the connection type", () => {
    dialog.open(null, []);
    const kind = el<HTMLSelectElement>("#device-kind");
    kind.value = "serial";
    kind.dispatchEvent(new Event("change"));
    expect(el("#serial-fields").classList.contains("device-kind-hidden")).toBe(false);
    expect(el("#ssh-fields").classList.contains("device-kind-hidden")).toBe(true);
  });
});
