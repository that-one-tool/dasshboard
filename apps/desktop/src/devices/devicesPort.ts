/** What the device catalog needs from the backend: the saved devices.
 * `ipcDevicesPort` is the real one; tests use `FakeDevicesPort`
 * (`fakeDevicesPort.testing.ts`). */

import { listDevices, type Device } from "../ipc";

export interface DevicesPort {
  listDevices(): Promise<Device[]>;
}

export const ipcDevicesPort: DevicesPort = { listDevices };
