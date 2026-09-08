import { describe, it, expect } from "vitest";
import { deviceEndpoint } from "./deviceEndpoint";
import type { Device } from "../ipc";

const sshDevice: Device = {
  id: "1",
  name: "NAS",
  kind: "ssh",
  host: "10.0.0.1",
  port: 22,
  username: "admin",
  auth: { method: "password" },
  autoReconnect: false,
};

const serialDevice: Device = {
  id: "2",
  name: "Arduino",
  kind: "serial",
  portName: "COM3",
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
  autoReconnect: false,
};

describe("deviceEndpoint", () => {
  it("renders host:port for an SSH device", () => {
    expect(deviceEndpoint(sshDevice)).toBe("10.0.0.1:22");
  });

  it("renders portName @ baudRate for a serial device", () => {
    expect(deviceEndpoint(serialDevice)).toBe("COM3 @ 115200");
  });
});
