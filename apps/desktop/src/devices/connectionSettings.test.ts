import { describe, it, expect } from "vitest";
import type { Device, SshDevice } from "../ipc";
import { connectionKeyOf, isConnectionSettingsChanged } from "./connectionSettings";

const shell: Device = {
  id: "a",
  name: "Shell",
  kind: "localShell",
  shell: null,
  cwd: null,
  autoReconnect: false,
  tags: [],
  connectSnippet: null,
};

describe("isConnectionSettingsChanged", () => {
  it("is false for the same settings under a new name", () => {
    expect(isConnectionSettingsChanged(shell, { ...shell, name: "Other" })).toBe(false);
  });

  it("is true when the shell changes", () => {
    expect(isConnectionSettingsChanged(shell, { ...shell, shell: "/bin/zsh" })).toBe(true);
  });
});

describe("connectionKeyOf", () => {
  const ssh: SshDevice = {
    id: "s",
    name: "NAS",
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    auth: { method: "password" },
    forwards: [],
    tunnelAutoStart: false,
    proxyJump: null,
    forwardAgent: false,
    x11Forwarding: "off",
    autoReconnect: false,
    tags: [],
    connectSnippet: null,
  };

  it("differs only when one of the given fields differs", () => {
    expect(connectionKeyOf(ssh, ["host"])).toBe(connectionKeyOf({ ...ssh, port: 2222 }, ["host"]));
    expect(connectionKeyOf(ssh, ["host"])).not.toBe(connectionKeyOf({ ...ssh, host: "h" }, ["host"]));
  });
});
