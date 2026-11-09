/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { Device } from "../../ipc";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { deviceManagerMarkup } from "../deviceDialogTemplate";
import { DeviceDialog } from "./deviceDialog";
import { DeviceFormActions } from "./deviceFormActions";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const alpha = {
  id: "a", name: "Alpha", kind: "ssh", host: "a.lan", port: 22, username: "me",
  auth: { method: "password" }, forwards: [], tunnelAutoStart: false, proxyJump: null,
  forwardAgent: false, x11Forwarding: "off", autoReconnect: false, tags: [], connectSnippet: null,
} as Device;

let container: HTMLElement;
let dialog: DeviceDialog;
let feedback: { error: Mock<(error: unknown) => void>; success: Mock<(message: string) => void> };
let reload: Mock<() => Promise<void>>;

function el<T extends Element>(selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(selector);
  return found;
}

function commands(): unknown[] {
  return invokeMock.mock.calls.map((call) => call[0]);
}

function isOpen(): boolean {
  return !el("#device-dialog").classList.contains("dialog-hidden");
}

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(true);
  document.body.innerHTML = `<div class="device-list">${deviceManagerMarkup()}</div>`;
  container = document.body.firstElementChild as HTMLElement;
  dialog = new DeviceDialog(container);
  dialog.attach();
  feedback = { error: vi.fn(), success: vi.fn() };
  reload = vi.fn(async () => {});
  new DeviceFormActions(container, dialog, feedback, reload).attach();
  dialog.open("a", [alpha]);
  invokeMock.mockClear();
});

function submit(): void {
  el<HTMLFormElement>("#device-form").dispatchEvent(new Event("submit", { cancelable: true }));
}

describe("DeviceFormActions save", () => {
  it("saves, reports, closes the dialog and reloads", async () => {
    invokeMock.mockResolvedValue(alpha);
    el<HTMLInputElement>("#device-secret").value = "pw";
    submit();
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("save_device", expect.objectContaining({ secret: "pw" }));
    expect(feedback.success).toHaveBeenCalledWith("Device saved");
    expect(isOpen()).toBe(false);
    expect(reload).toHaveBeenCalled();
  });

  it("keeps the dialog open and reports a failed save", async () => {
    const failure = { code: "Io", message: "nope" };
    invokeMock.mockRejectedValue(failure);
    submit();
    await flush();
    expect(feedback.error).toHaveBeenCalledWith(failure);
    expect(isOpen()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("saves nothing while the form is invalid", async () => {
    el<HTMLInputElement>("#device-name").value = "";
    submit();
    await flush();
    expect(commands()).not.toContain("save_device");
  });

  it("can save again once the first save finished", async () => {
    invokeMock.mockResolvedValue(alpha);
    submit();
    await flush();
    dialog.open("a", [alpha]);
    submit();
    await flush();
    expect(commands().filter((c) => c === "save_device")).toHaveLength(2);
  });
});

describe("DeviceFormActions test connection", () => {
  it("shows Testing… while it runs, then restores the button", async () => {
    let finish: (value: unknown) => void = () => {};
    invokeMock.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const button = el<HTMLButtonElement>(".btn-test-connection");
    const label = button.textContent;
    button.click();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Testing…");
    finish(undefined);
    await flush();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(label);
    expect(feedback.success).toHaveBeenCalledWith("Connection succeeded");
  });

  it("reports a failed test and restores the button", async () => {
    invokeMock.mockRejectedValue({ code: "Auth", message: "denied" });
    const button = el<HTMLButtonElement>(".btn-test-connection");
    button.click();
    await flush();
    expect(feedback.error).toHaveBeenCalledWith({ code: "Auth", message: "denied" });
    expect(button.disabled).toBe(false);
  });

  it("tests nothing while the form is invalid", async () => {
    el<HTMLInputElement>("#device-name").value = "";
    el<HTMLButtonElement>(".btn-test-connection").click();
    await flush();
    expect(commands()).not.toContain("test_connection");
  });
});

describe("DeviceFormActions agent refresh", () => {
  const key = (fingerprint: string, isCertificate = false) => ({
    fingerprint, comment: fingerprint, algorithm: "ssh-ed25519", isCertificate,
  });

  it("lists the agent's bare keys and shows their count", async () => {
    invokeMock.mockResolvedValue([key("SHA256:one"), key("SHA256:cert", true)]);
    el<HTMLButtonElement>("#device-agent-refresh").click();
    expect(el<HTMLButtonElement>("#device-agent-refresh").disabled).toBe(true);
    expect(el("#device-agent-status").textContent).toBe("Querying the SSH agent…");
    await flush();
    const options = [...el<HTMLSelectElement>("#device-agent-identity").options].map((o) => o.value);
    expect(options).toContain("SHA256:one");
    expect(options).not.toContain("SHA256:cert");
    expect(el("#device-agent-status").textContent).toBe("1 identity available");
    expect(el<HTMLButtonElement>("#device-agent-refresh").disabled).toBe(false);
  });

  it("says when the agent holds no keys", async () => {
    invokeMock.mockResolvedValue([]);
    el<HTMLButtonElement>("#device-agent-refresh").click();
    await flush();
    expect(el("#device-agent-status").textContent).toBe("The agent is running but holds no keys.");
  });

  it("shows the agent error", async () => {
    invokeMock.mockRejectedValue({ code: "Agent", message: "socket gone" });
    el<HTMLButtonElement>("#device-agent-refresh").click();
    await flush();
    expect(el("#device-agent-status").textContent).toBe("socket gone");
    expect(el<HTMLButtonElement>("#device-agent-refresh").disabled).toBe(false);
  });
});
