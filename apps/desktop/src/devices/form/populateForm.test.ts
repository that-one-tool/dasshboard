/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Device } from "../../ipc";
import { deviceManagerMarkup } from "../deviceDialogTemplate";
import { populateForm } from "./populateForm";

let root: HTMLElement;

function q<T extends Element>(selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}

function value(selector: string): string {
  return root.querySelector<HTMLInputElement>(selector)!.value;
}

function checked(selector: string): boolean {
  return root.querySelector<HTMLInputElement>(selector)!.checked;
}

beforeEach(() => {
  root = document.createElement("div");
  root.innerHTML = deviceManagerMarkup();
});

const ssh: Device = {
  id: "s1", name: "Web", kind: "ssh", host: "web.lan", port: 2222, username: "ops",
  auth: { method: "key", keyPath: "/k/id" }, forwards: [], tunnelAutoStart: true, proxyJump: null,
  forwardAgent: true, x11Forwarding: "trusted", autoReconnect: true, tags: ["prod", "web"], connectSnippet: "uptime",
};

describe("populateForm", () => {
  it("fills the common and SSH fields and shows the SSH group", () => {
    populateForm(root, ssh);
    expect(value("#device-name")).toBe("Web");
    expect(value("#device-tags")).toBe("prod, web");
    expect(value("#device-port")).toBe("2222");
    expect(value("#device-key-path")).toBe("/k/id");
    expect(value("#device-x11-forwarding")).toBe("trusted");
    expect(value("#device-connect-snippet")).toBe("uptime");
    expect(checked('input[name="auth-method"][value="key"]')).toBe(true);
    expect(checked("#device-tunnel-autostart")).toBe(true);
    expect(checked("#device-forward-agent")).toBe(true);
    expect(checked("#device-auto-reconnect")).toBe(true);
    expect(root.querySelector("#ssh-fields")?.classList.contains("device-kind-hidden")).toBe(false);
    expect(root.querySelector("#auth-key")?.classList.contains("auth-method-hidden")).toBe(false);
  });

  it("seeds the agent picker with the saved fingerprint", () => {
    populateForm(root, { ...ssh, auth: { method: "agent", fingerprint: "SHA256:x" } } as Device);
    expect(checked('input[name="auth-method"][value="agent"]')).toBe(true);
    expect(value("#device-agent-identity")).toBe("SHA256:x");
  });

  it("falls back to x11 off and a blank snippet when absent", () => {
    populateForm(root, { ...ssh, x11Forwarding: undefined, connectSnippet: null } as unknown as Device);
    expect(value("#device-x11-forwarding")).toBe("off");
    expect(value("#device-connect-snippet")).toBe("");
  });

  it("fills serial fields, adding a custom baud rate", () => {
    populateForm(root, {
      id: "c", name: "Uno", kind: "serial", portName: "COM9", baudRate: 12345, dataBits: 7,
      parity: "even", stopBits: 2, flowControl: "hardware", autoReconnect: false, tags: [], connectSnippet: null,
    } as Device);
    expect(value("#device-port-name")).toBe("COM9");
    expect(value("#device-baud-rate")).toBe("12345");
    expect(root.querySelector("#device-baud-rate option:last-child")?.textContent).toBe("12345 (custom)");
    expect(value("#device-parity")).toBe("even");
    expect(root.querySelector("#serial-fields")?.classList.contains("device-kind-hidden")).toBe(false);
  });

  it("fills local-shell fields, blank when unset", () => {
    populateForm(root, {
      id: "l", name: "Shell", kind: "localShell", shell: null, cwd: "/tmp",
      autoReconnect: false, tags: [], connectSnippet: null,
    } as Device);
    expect(value("#device-shell")).toBe("");
    expect(value("#device-cwd")).toBe("/tmp");
  });
});

describe("populateForm details", () => {
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
      proxyJump: null,
      forwardAgent: true,
      x11Forwarding: "trusted",
      autoReconnect: true,
      tags: ["web", "prod"],
      connectSnippet: "uptime\nwhoami",
    };

    populateForm(root, device);

    expect(q<HTMLInputElement>("#device-name").value).toBe("Alpha");
    expect(q<HTMLTextAreaElement>("#device-connect-snippet").value).toBe("uptime\nwhoami");
    expect(q<HTMLInputElement>("#device-host").value).toBe("10.0.0.9");
    expect(q<HTMLInputElement>("#device-key-path").value).toBe("C:/k");
    expect(
      q<HTMLInputElement>('input[name="auth-method"][value="key"]').checked,
    ).toBe(true);
    expect(q<HTMLInputElement>("#device-tunnel-autostart").checked).toBe(true);
    expect(q<HTMLInputElement>("#device-forward-agent").checked).toBe(true);
    expect(q<HTMLSelectElement>("#device-x11-forwarding").value).toBe("trusted");
    expect(q<HTMLInputElement>("#device-auto-reconnect").checked).toBe(true);
    expect(q<HTMLInputElement>("#device-tags").value).toBe("web, prod");
    expect(
      q("#serial-fields").classList.contains("device-kind-hidden"),
    ).toBe(true);
  });

  it("resets x11Forwarding to off for a record without the field", () => {
    q<HTMLSelectElement>("#device-x11-forwarding").value = "trusted";
    const device = {
      id: "old",
      name: "Old",
      kind: "ssh",
      host: "h",
      port: 22,
      username: "u",
      auth: { method: "password" },
      forwards: [],
      tunnelAutoStart: false,
      proxyJump: null,
      forwardAgent: false,
      autoReconnect: false,
      tags: [],
      connectSnippet: null,
    } as unknown as Device;

    populateForm(root, device);

    expect(q<HTMLSelectElement>("#device-x11-forwarding").value).toBe("off");
  });

  it("selects agent auth and seeds the picker with the saved fingerprint", () => {
    const device: Device = {
      id: "dev-agent",
      name: "Token",
      kind: "ssh",
      host: "h",
      port: 22,
      username: "u",
      auth: { method: "agent", fingerprint: "SHA256:zzz" },
      forwards: [],
      tunnelAutoStart: false,
      proxyJump: null,
      forwardAgent: false,
      x11Forwarding: "off",
      autoReconnect: false,
      tags: [],
      connectSnippet: null,
    };

    populateForm(root, device);

    expect(
      q<HTMLInputElement>('input[name="auth-method"][value="agent"]').checked,
    ).toBe(true);
    const select = q<HTMLSelectElement>("#device-agent-identity");
    expect(select.value).toBe("SHA256:zzz");
    // The agent section is shown, password/key hidden.
    expect(q("#auth-agent").classList.contains("auth-method-hidden")).toBe(false);
    expect(q("#auth-password").classList.contains("auth-method-hidden")).toBe(true);
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
      tags: [],
      connectSnippet: null,
    };

    populateForm(root, device);

    const select = q<HTMLSelectElement>("#device-baud-rate");
    expect(select.value).toBe("12345");
    expect(Array.from(select.options).some((o) => o.value === "12345")).toBe(
      true,
    );
  });
});
