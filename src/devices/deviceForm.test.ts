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
  populateAgentIdentities,
  populateForm,
  readFormValues,
  selectedKind,
  setSecretPlaceholder,
  updateAuthMethodDisplay,
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

  it("reads the selected fingerprint when agent auth is chosen", () => {
    q<HTMLInputElement>('input[name="auth-method"][value="agent"]').checked = true;
    // A live refresh would fill these; simulate a selection.
    populateAgentIdentities(
      root,
      [
        {
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:aaa",
          isSecurityKey: false,
          isCertificate: false,
          comment: "yubikey",
          openssh: "ssh-ed25519 AAAA yubikey",
        },
      ],
      "SHA256:aaa",
    );

    const values = readFormValues(root, "", []);

    expect(values.auth).toEqual({ method: "agent", fingerprint: "SHA256:aaa" });
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

  it("parses the tags input (trim/dedupe) into the values", () => {
    q<HTMLInputElement>("#device-name").value = "NAS";
    q<HTMLInputElement>("#device-host").value = "10.0.0.1";
    q<HTMLInputElement>("#device-port").value = "22";
    q<HTMLInputElement>("#device-username").value = "root";
    q<HTMLInputElement>("#device-tags").value = "prod, Prod , web";

    expect(readFormValues(root, "dev-1", []).tags).toEqual(["prod", "web"]);
  });

  it("reads proxyJump as null when 'None' is selected, and the selected id otherwise", () => {
    q<HTMLInputElement>("#device-name").value = "NAS";
    q<HTMLInputElement>("#device-host").value = "10.0.0.1";
    q<HTMLInputElement>("#device-port").value = "22";
    q<HTMLInputElement>("#device-username").value = "root";

    // Default ("None") ⇒ null.
    expect(readFormValues(root, "dev-1", []).proxyJump).toBeNull();

    // With a jump option present and selected ⇒ that id.
    const select = q<HTMLSelectElement>("#device-proxy-jump");
    const opt = document.createElement("option");
    opt.value = "bastion-id";
    select.appendChild(opt);
    select.value = "bastion-id";
    expect(readFormValues(root, "dev-1", []).proxyJump).toBe("bastion-id");
  });

  it("reads forwardAgent from the checkbox", () => {
    q<HTMLInputElement>("#device-name").value = "NAS";
    q<HTMLInputElement>("#device-host").value = "10.0.0.1";
    q<HTMLInputElement>("#device-port").value = "22";
    q<HTMLInputElement>("#device-username").value = "root";

    // Default (unchecked) ⇒ false.
    expect(readFormValues(root, "dev-1", []).forwardAgent).toBe(false);

    q<HTMLInputElement>("#device-forward-agent").checked = true;
    expect(readFormValues(root, "dev-1", []).forwardAgent).toBe(true);
  });

  it("reads the connect snippet (blank ⇒ null, otherwise trimmed text)", () => {
    q<HTMLInputElement>("#device-name").value = "NAS";
    q<HTMLInputElement>("#device-host").value = "10.0.0.1";
    q<HTMLInputElement>("#device-port").value = "22";
    q<HTMLInputElement>("#device-username").value = "root";

    // Blank textarea ⇒ null.
    expect(readFormValues(root, "dev-1", []).connectSnippet).toBeNull();

    q<HTMLTextAreaElement>("#device-connect-snippet").value = "uptime\nwhoami";
    expect(readFormValues(root, "dev-1", []).connectSnippet).toBe("uptime\nwhoami");
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
      proxyJump: null,
      forwardAgent: true,
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
    expect(q<HTMLInputElement>("#device-auto-reconnect").checked).toBe(true);
    expect(q<HTMLInputElement>("#device-tags").value).toBe("web, prod");
    expect(
      q("#serial-fields").classList.contains("device-kind-hidden"),
    ).toBe(true);
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

describe("field-group and secret helpers", () => {
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

  it("updateKindDisplay shows only the local-shell group for a local shell", () => {
    q<HTMLSelectElement>("#device-kind").value = "localShell";
    updateKindDisplay(root);
    expect(q("#ssh-fields").classList.contains("device-kind-hidden")).toBe(true);
    expect(q("#serial-fields").classList.contains("device-kind-hidden")).toBe(true);
    expect(
      q("#local-shell-fields").classList.contains("device-kind-hidden"),
    ).toBe(false);
  });

  it("updateAuthMethodDisplay shows only the checked method's section", () => {
    q<HTMLInputElement>('input[name="auth-method"][value="agent"]').checked = true;
    updateAuthMethodDisplay(root);
    expect(q("#auth-agent").classList.contains("auth-method-hidden")).toBe(false);
    expect(q("#auth-key").classList.contains("auth-method-hidden")).toBe(true);
    expect(q("#auth-password").classList.contains("auth-method-hidden")).toBe(true);
  });

  it("populateAgentIdentities keeps a saved fingerprint the agent no longer lists", () => {
    populateAgentIdentities(
      root,
      [
        {
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:live",
          isSecurityKey: true,
          isCertificate: false,
          comment: "",
          openssh: "ssh-ed25519 AAAA",
        },
      ],
      "SHA256:gone",
    );
    const select = q<HTMLSelectElement>("#device-agent-identity");
    // Both the live key and the (marked) saved-but-absent fingerprint are options,
    // and the saved one stays selected so saving doesn't silently change it.
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("SHA256:live");
    expect(values).toContain("SHA256:gone");
    expect(select.value).toBe("SHA256:gone");
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
    // Absent snippet ⇒ null (always emitted, like proxyJump).
    expect(device.connectSnippet).toBeNull();
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
