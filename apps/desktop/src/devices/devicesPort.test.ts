import { describe, it, expect, vi } from "vitest";

vi.mock("../ipc", () => ({ listDevices: vi.fn(async () => []) }));

import { listDevices } from "../ipc";
import { ipcDevicesPort } from "./devicesPort";

describe("ipcDevicesPort", () => {
  it("lists devices through the IPC command", async () => {
    await ipcDevicesPort.listDevices();
    expect(listDevices).toHaveBeenCalled();
  });
});
