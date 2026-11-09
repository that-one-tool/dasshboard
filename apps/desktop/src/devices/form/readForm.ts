/** Reads the device dialog's inputs into form values. */

import type { Auth, DeviceKind, FlowControl, Forward, Parity, X11Forwarding } from "../../ipc";
import { parseTags } from "../deviceFilter";
import type { DeviceFormValues } from "../validation";
import { selectedKind } from "./formDisplay";
import { blankToNull, inputChecked, inputInt, inputValue } from "./formFields";

type KindReader = (form: ParentNode, forwards: Forward[]) => DeviceFormValues;

const KIND_READERS: Record<DeviceKind, KindReader> = {
  ssh: readSshValues,
  serial: readSerialValues,
  localShell: readLocalShellValues,
};

const AUTH_READERS = new Map<string, (form: ParentNode) => Auth>([
  ["key", (form) => ({ method: "key", keyPath: inputValue(form, "#device-key-path") })],
  ["agent", (form) => ({ method: "agent", fingerprint: inputValue(form, "#device-agent-identity") })],
]);

/**
 * Read every dialog input into a form-values object. `forwards` is supplied by
 * the caller (the forwards sub-editor lives in the controller); `secret` is
 * always read (the inputs are hidden, not removed, for a serial device — the
 * save path drops it via `decideSecretToSend`).
 */
export function readFormValues(
  root: ParentNode,
  editingDeviceId: string | null,
  forwards: Forward[],
): DeviceFormValues & { id: string; secret: string } {
  const form = root.querySelector<HTMLFormElement>("#device-form");
  if (!form) return { id: "", secret: "" };
  const common = readCommonValues(form, editingDeviceId);
  return { ...common, ...KIND_READERS[selectedKind(form)](form, forwards) };
}

function readCommonValues(form: ParentNode, editingDeviceId: string | null) {
  return {
    id: editingDeviceId ?? "",
    name: inputValue(form, "#device-name"),
    tags: parseTags(inputValue(form, "#device-tags")),
    autoReconnect: inputChecked(form, "#device-auto-reconnect"),
    connectSnippet: blankToNull(inputValue(form, "#device-connect-snippet")),
    secret: readSecret(form),
  };
}

/** The secret input matching the selected auth method: the key passphrase for
 * key auth, else the password. The other input is only hidden, so a value typed
 * there before switching methods must not be saved as this method's secret. */
function readSecret(form: ParentNode): string {
  const method = form.querySelector<HTMLInputElement>('input[name="auth-method"]:checked')?.value;
  return inputValue(form, method === "key" ? "#device-passphrase" : "#device-secret");
}

/** Read the local-shell inputs (shell + cwd) into a form-values fragment. A
 * blank field maps to `null` (⇒ OS default shell / home dir). */
function readLocalShellValues(form: ParentNode): DeviceFormValues {
  return {
    kind: "localShell",
    shell: blankToNull(inputValue(form, "#device-shell")),
    cwd: blankToNull(inputValue(form, "#device-cwd")),
  };
}

/** Read the SSH-only inputs into a form-values fragment. */
function readSshValues(form: ParentNode, forwards: Forward[]): DeviceFormValues {
  const auth = readAuth(form);
  return {
    kind: "ssh",
    host: inputValue(form, "#device-host"),
    port: inputInt(form, "#device-port"),
    username: inputValue(form, "#device-username"),
    auth,
    forwards,
    tunnelAutoStart: inputChecked(form, "#device-tunnel-autostart"),
    proxyJump: readProxyJump(form),
    forwardAgent: inputChecked(form, "#device-forward-agent"),
    x11Forwarding: inputValue(form, "#device-x11-forwarding") as X11Forwarding,
  };
}

/** Any method other than key or agent reads as password. */
function readAuth(form: ParentNode): Auth {
  const method = inputValue(form, 'input[name="auth-method"]:checked');
  return AUTH_READERS.get(method)?.(form) ?? { method: "password" };
}

/** Empty jump-host selection ("None") maps to null (a direct connection). */
function readProxyJump(form: ParentNode): string | null {
  const value = inputValue(form, "#device-proxy-jump");
  return value === "" ? null : value;
}

/** Read the serial-only inputs (port + framing) into a form-values fragment. */
function readSerialValues(form: ParentNode): DeviceFormValues {
  return {
    kind: "serial",
    portName: inputValue(form, "#device-port-name"),
    baudRate: inputInt(form, "#device-baud-rate"),
    dataBits: inputInt(form, "#device-data-bits"),
    parity: inputValue(form, "#device-parity") as Parity,
    stopBits: inputInt(form, "#device-stop-bits"),
    flowControl: inputValue(form, "#device-flow-control") as FlowControl,
  };
}
