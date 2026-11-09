/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Forward } from "../../ipc";
import { deviceManagerMarkup } from "../deviceDialogTemplate";
import { readFormValues } from "./readForm";

let root: HTMLElement;

function q<T extends Element>(selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}

function set(selector: string, value: string): void {
  root.querySelector<HTMLInputElement>(selector)!.value = value;
}

function check(selector: string): void {
  root.querySelector<HTMLInputElement>(selector)!.checked = true;
}

beforeEach(() => {
  root = document.createElement("div");
  root.innerHTML = deviceManagerMarkup();
  set("#device-name", "Box");
  set("#device-tags", "a, b");
});

const forwards: Forward[] = [
  { id: "f", name: "web", kind: "local", localAddr: "127.0.0.1", localPort: 8080, remoteHost: "x", remotePort: 80 },
];

describe("readFormValues", () => {
  it("returns only an empty id and secret without the form", () => {
    root.innerHTML = "";
    expect(readFormValues(root, "id", [])).toEqual({ id: "", secret: "" });
  });

  it("reads common and SSH values with password auth and no jump host", () => {
    set("#device-host", "h");
    set("#device-port", "22");
    set("#device-secret", "pw");
    set("#device-connect-snippet", "   ");
    expect(readFormValues(root, null, forwards)).toMatchObject({
      id: "", name: "Box", tags: ["a", "b"], connectSnippet: null, secret: "pw",
      kind: "ssh", host: "h", port: 22, auth: { method: "password" }, forwards, proxyJump: null,
    });
  });

  it("reads key auth with the passphrase as the secret", () => {
    check('input[name="auth-method"][value="key"]');
    set("#device-key-path", "/k");
    set("#device-secret", "stale");
    set("#device-passphrase", "pp");
    expect(readFormValues(root, "d", [])).toMatchObject({ id: "d", auth: { method: "key", keyPath: "/k" }, secret: "pp" });
  });

  it("reads agent auth with the chosen fingerprint", () => {
    check('input[name="auth-method"][value="agent"]');
    root.querySelector("#device-agent-identity")!.innerHTML = `<option value="SHA256:x">x</option>`;
    expect(readFormValues(root, null, []).auth).toEqual({ method: "agent", fingerprint: "SHA256:x" });
  });

  it("reads serial values", () => {
    set("#device-kind", "serial");
    set("#device-port-name", "COM3");
    set("#device-baud-rate", "9600");
    const values = readFormValues(root, null, forwards);
    expect(values).toMatchObject({ kind: "serial", portName: "COM3", baudRate: 9600 });
    expect(values).not.toHaveProperty("forwards");
  });

  it("reads local-shell values, blank as null", () => {
    set("#device-kind", "localShell");
    set("#device-shell", " zsh ");
    expect(readFormValues(root, null, [])).toMatchObject({ kind: "localShell", shell: "zsh", cwd: null });
  });
});

describe("readFormValues fields", () => {
  beforeEach(() => {
    root = document.createElement("div");
    root.innerHTML = deviceManagerMarkup();
  });

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

  it("ignores a passphrase left in the hidden passphrase field for password auth", () => {
    q<HTMLInputElement>("#device-passphrase").value = "stale-pass";
    q<HTMLInputElement>("#device-secret").value = "hunter2";

    expect(readFormValues(root, "", []).secret).toBe("hunter2");
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

  it("reads x11Forwarding from the select, off by default", () => {
    q<HTMLInputElement>("#device-name").value = "NAS";
    q<HTMLInputElement>("#device-host").value = "10.0.0.1";
    q<HTMLInputElement>("#device-port").value = "22";
    q<HTMLInputElement>("#device-username").value = "root";

    expect(readFormValues(root, "dev-1", []).x11Forwarding).toBe("off");

    for (const mode of ["untrusted", "trusted"] as const) {
      q<HTMLSelectElement>("#device-x11-forwarding").value = mode;
      expect(readFormValues(root, "dev-1", []).x11Forwarding).toBe(mode);
    }
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
});
