/**
 * Builds the `Device` to save from validated form values, filling kind-specific
 * defaults for completeness (validation has already run, so these defaults are
 * only a type-level backstop). Only the device's own fields are copied, so the
 * form's `secret` never ends up in the device.
 */

import type { Device } from "../../ipc";
import type { DeviceFormValues } from "../validation";

type DeviceOf<K extends Device["kind"]> = Extract<Device, { kind: K }>;
type Fields<D extends Device> = Omit<D, "id" | "name" | "autoReconnect" | "tags" | "connectSnippet" | "kind">;
type FormDevice = DeviceFormValues & { id: string };

export function buildDeviceFromForm(values: FormDevice): Device {
  const common = { id: values.id, ...withDefaults(commonDefaults(), values) };
  if (values.kind === "serial") return { ...common, kind: "serial", ...withDefaults(serialDefaults(), values) };
  if (values.kind === "localShell") return { ...common, kind: "localShell", ...withDefaults(localShellDefaults(), values) };
  return { ...common, kind: "ssh", ...withDefaults(sshDefaults(), values) };
}

/** `defaults`' keys, each taking the value's field unless that is null/undefined. */
function withDefaults<T extends object>(defaults: T, values: Partial<T>): T {
  const merged = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    merged[key] = values[key] ?? defaults[key];
  }
  return merged;
}

function commonDefaults(): Omit<Device, "id" | "kind"> {
  return { name: "", autoReconnect: false, tags: [], connectSnippet: null };
}

function serialDefaults(): Fields<DeviceOf<"serial">> {
  return { portName: "", baudRate: 0, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none" };
}

function localShellDefaults(): Fields<DeviceOf<"localShell">> {
  return { shell: null, cwd: null };
}

function sshDefaults(): Fields<DeviceOf<"ssh">> {
  return {
    host: "",
    port: 0,
    username: "",
    auth: { method: "password" },
    forwards: [],
    tunnelAutoStart: false,
    proxyJump: null,
    forwardAgent: false,
    x11Forwarding: "off",
  };
}
