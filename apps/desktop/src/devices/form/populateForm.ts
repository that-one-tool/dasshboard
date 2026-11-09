/** Fills the device dialog from a saved device (the edit path). */

import type { Auth, Device } from "../../ipc";
import { createOption, requireEl } from "../../ui/dom";
import { populateAgentIdentities } from "./agentIdentities";
import { updateAuthMethodDisplay, updateKindDisplay } from "./formDisplay";
import { setChecked, setInputValue } from "./formFields";

type DeviceOf<K extends Device["kind"]> = Extract<Device, { kind: K }>;

/** Populate every dialog input from a saved device (the edit path). */
export function populateForm(root: ParentNode, device: Device): void {
  setInputValue(root, "#device-name", device.name);
  setInputValue(root, "#device-tags", device.tags.join(", "));
  setInputValue(root, "#device-kind", device.kind);
  populateKindFields(root, device);
  setChecked(root, "#device-auto-reconnect", device.autoReconnect);
  setInputValue(root, "#device-connect-snippet", device.connectSnippet);
  updateKindDisplay(root);
  updateAuthMethodDisplay(root);
}

function populateKindFields(root: ParentNode, device: Device): void {
  if (device.kind === "serial") return populateSerialFields(root, device);
  if (device.kind === "localShell") return populateLocalShellFields(root, device);
  populateSshFields(root, device);
}

function populateLocalShellFields(root: ParentNode, device: DeviceOf<"localShell">): void {
  setInputValue(root, "#device-shell", device.shell);
  setInputValue(root, "#device-cwd", device.cwd);
}

/** Fill the SSH-only inputs (host/port/username/auth) from a device. */
function populateSshFields(root: ParentNode, device: DeviceOf<"ssh">): void {
  setInputValue(root, "#device-host", device.host);
  setInputValue(root, "#device-port", device.port);
  setInputValue(root, "#device-username", device.username);
  populateAuth(root, device.auth);
  // The jump-host <select>'s options are populated by the controller from the
  // device list before this runs; setting `.value` to an id not in the list
  // (e.g. a since-deleted jump host) harmlessly falls back to "None" ("").
  setInputValue(root, "#device-proxy-jump", device.proxyJump);
  setChecked(root, "#device-tunnel-autostart", device.tunnelAutoStart);
  setChecked(root, "#device-forward-agent", device.forwardAgent);
  setInputValue(root, "#device-x11-forwarding", device.x11Forwarding ?? "off");
}

function populateAuth(root: ParentNode, auth: Auth): void {
  requireEl<HTMLInputElement>(root, `input[name="auth-method"][value="${auth.method}"]`).checked = true;
  if (auth.method === "key") setInputValue(root, "#device-key-path", auth.keyPath);
  // Seed the picker with the saved fingerprint so it round-trips even before
  // a live agent refresh (which the controller triggers on demand).
  if (auth.method === "agent") populateAgentIdentities(root, [], auth.fingerprint);
}

/** Fill the serial-only inputs (port + framing) from a device. */
function populateSerialFields(root: ParentNode, device: DeviceOf<"serial">): void {
  setInputValue(root, "#device-port-name", device.portName);
  // The baud-rate select offers the classic presets; a device saved with a
  // non-standard rate (imported / hand-edited) gets that value added as an
  // option so it still selects rather than silently snapping to a preset.
  ensureBaudOption(root, device.baudRate);
  setInputValue(root, "#device-baud-rate", device.baudRate);
  setInputValue(root, "#device-data-bits", device.dataBits);
  setInputValue(root, "#device-parity", device.parity);
  setInputValue(root, "#device-stop-bits", device.stopBits);
  setInputValue(root, "#device-flow-control", device.flowControl);
}

/** Add a one-off `<option>` for a non-preset baud rate so it can be selected. */
function ensureBaudOption(root: ParentNode, baudRate: number): void {
  const select = root.querySelector<HTMLSelectElement>("#device-baud-rate");
  if (!select) return;
  const value = String(baudRate);
  if (Array.from(select.options).some((o) => o.value === value)) return;
  select.appendChild(createOption(value, `${value} (custom)`));
}
