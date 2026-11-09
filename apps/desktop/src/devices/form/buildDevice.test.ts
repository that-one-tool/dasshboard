import { describe, it, expect } from "vitest";
import { buildDeviceFromForm } from "./buildDevice";

describe("buildDeviceFromForm", () => {
  it("fills SSH defaults for missing values, in a fresh object each time", () => {
    const first = buildDeviceFromForm({ id: "a" });
    expect(first).toEqual({
      id: "a", name: "", autoReconnect: false, tags: [], connectSnippet: null,
      kind: "ssh", host: "", port: 0, username: "", auth: { method: "password" }, forwards: [],
      tunnelAutoStart: false, proxyJump: null, forwardAgent: false, x11Forwarding: "off",
    });
    const second = buildDeviceFromForm({ id: "b" });
    expect(second.tags).not.toBe(first.tags);
  });

  it("keeps given values, including falsy ones, and drops the secret", () => {
    const device = buildDeviceFromForm({
      id: "a", name: "N", kind: "ssh", port: 22, autoReconnect: true, forwardAgent: false,
      proxyJump: "j", secret: "pw",
    } as Parameters<typeof buildDeviceFromForm>[0]);
    expect(device).toMatchObject({ name: "N", port: 22, autoReconnect: true, proxyJump: "j" });
    expect(device).not.toHaveProperty("secret");
  });

  it("builds a serial device with framing defaults", () => {
    expect(buildDeviceFromForm({ id: "s", kind: "serial", portName: "COM3" })).toEqual({
      id: "s", name: "", autoReconnect: false, tags: [], connectSnippet: null,
      kind: "serial", portName: "COM3", baudRate: 0, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none",
    });
  });

  it("builds a local-shell device with no SSH fields", () => {
    expect(buildDeviceFromForm({ id: "l", kind: "localShell", cwd: "/tmp", host: "ignored" })).toEqual({
      id: "l", name: "", autoReconnect: false, tags: [], connectSnippet: null,
      kind: "localShell", shell: null, cwd: "/tmp",
    });
  });
});

describe("buildDeviceFromForm mapping", () => {
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
    // Absent snippet ⇒ null (always emitted, like proxyJump).
    expect(device.connectSnippet).toBeNull();
  });

  it("carries x11Forwarding, off when absent", () => {
    const values = {
      id: "dev-1",
      kind: "ssh" as const,
      name: "NAS",
      host: "10.0.0.1",
      port: 22,
      username: "root",
      auth: { method: "password" as const },
      autoReconnect: false,
    };
    expect(buildDeviceFromForm({ ...values, x11Forwarding: "untrusted" })).toMatchObject({
      x11Forwarding: "untrusted",
    });
    expect(buildDeviceFromForm(values)).toMatchObject({ x11Forwarding: "off" });
  });

  it("carries the connect snippet onto the built device (any kind)", () => {
    const device = buildDeviceFromForm({
      id: "dev-1",
      kind: "ssh",
      name: "NAS",
      host: "10.0.0.1",
      port: 22,
      username: "root",
      auth: { method: "password" },
      forwards: [],
      autoReconnect: false,
      connectSnippet: "cd /tmp",
    });
    expect(device.connectSnippet).toBe("cd /tmp");
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

  it("maps local shell values (explicit shell + cwd)", () => {
    const device = buildDeviceFromForm({
      id: "dev-3",
      kind: "localShell",
      name: "PowerShell",
      shell: "pwsh.exe",
      cwd: "C:/work",
      autoReconnect: false,
    });
    expect(device).toMatchObject({
      kind: "localShell",
      shell: "pwsh.exe",
      cwd: "C:/work",
    });
  });

  it("defaults local shell shell/cwd to null when omitted", () => {
    const device = buildDeviceFromForm({
      id: "dev-4",
      kind: "localShell",
      name: "Default shell",
      autoReconnect: false,
    });
    expect(device).toMatchObject({ kind: "localShell", shell: null, cwd: null });
  });
});
