/** An in-memory `DevicesPort` for tests: counts fetches, and can hold or fail
 * the next one. */

import type { AppError, Device } from "../ipc";
import type { DevicesPort } from "./devicesPort";

export interface HeldFetch {
  release(): void;
  fail(error: AppError): void;
}

export class FakeDevicesPort implements DevicesPort {
  devices: Device[] = [];
  fetchCount = 0;
  private readonly scripted: Array<() => Promise<void>> = [];

  /** The next fetch waits until it is released or failed; it returns the
   * devices as they are when released. */
  hold(): HeldFetch {
    const held: HeldFetch = { release: () => {}, fail: () => {} };
    const gate = new Promise<void>((resolve, reject) => {
      held.release = resolve;
      held.fail = reject;
    });
    this.scripted.push(() => gate);
    return held;
  }

  /** The next fetch rejects with `error`. */
  failNext(error: AppError): void {
    this.scripted.push(() => Promise.reject(error));
  }

  async listDevices(): Promise<Device[]> {
    this.fetchCount += 1;
    await (this.scripted.shift()?.() ?? Promise.resolve());
    return [...this.devices];
  }
}
