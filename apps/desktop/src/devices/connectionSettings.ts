/** Which fields of a device a live session depends on: editing one only
 * takes effect on the next connect. Name, tags, the connect snippet,
 * auto-reconnect, tunnel auto-start and forwards are not among them. */

import type { Device, DeviceKind } from "../ipc";

type FieldsOf<Kind extends DeviceKind> = ReadonlyArray<keyof Extract<Device, { kind: Kind }>>;

const SSH_CONNECTION_FIELDS = [
  "host",
  "port",
  "username",
  "auth",
  "proxyJump",
  "forwardAgent",
  "x11Forwarding",
] as const satisfies FieldsOf<"ssh">;

export type SshConnectionField = (typeof SSH_CONNECTION_FIELDS)[number];

const CONNECTION_FIELDS: { [Kind in DeviceKind]: FieldsOf<Kind> } = {
  ssh: SSH_CONNECTION_FIELDS,
  serial: ["portName", "baudRate", "dataBits", "parity", "stopBits", "flowControl"],
  localShell: ["shell", "cwd"],
};

/** What connecting through a device uses of it: the hop has no shell, and the
 * backend doesn't follow the jump host's own jump host. */
const JUMP_HOP_FIELDS: ReadonlyArray<"kind" | SshConnectionField> = ["kind", "host", "port", "username", "auth"];

export function isConnectionSettingsChanged(before: Device, after: Device): boolean {
  return connectionKey(before) !== connectionKey(after);
}

/** Whether the edit matters to the devices that jump through this one. */
export function isJumpHopChanged(before: Device, after: Device): boolean {
  const fields = JUMP_HOP_FIELDS as ReadonlyArray<keyof Device>;
  return connectionKeyOf(before, fields) !== connectionKeyOf(after, fields);
}

/** The values of `fields`, comparable between two versions of a device. */
export function connectionKeyOf<AnyDevice extends Device>(
  device: AnyDevice,
  fields: ReadonlyArray<keyof AnyDevice>,
): string {
  return JSON.stringify(fields.map((field) => device[field]));
}

function connectionKey(device: Device): string {
  const fields = CONNECTION_FIELDS[device.kind] as ReadonlyArray<keyof Device>;
  return connectionKeyOf(device, ["kind", ...fields]);
}
