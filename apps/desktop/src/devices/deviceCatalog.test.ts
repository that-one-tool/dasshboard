import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppError, Device } from "../ipc";

const logToBackendMock = vi.hoisted(() => vi.fn());
vi.mock("../ipc", () => ({ logToBackend: logToBackendMock }));

import { DeviceCatalog, type DeviceChange } from "./deviceCatalog";
import type { DevicesPort } from "./devicesPort";
import { FakeDevicesPort } from "./fakeDevicesPort.testing";

function ssh(id: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    name: `ssh-${id}`,
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
    ...overrides,
  } as Device;
}

function serial(id: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    name: `serial-${id}`,
    kind: "serial",
    portName: "COM3",
    baudRate: 115200,
    dataBits: 8,
    parity: "none",
    stopBits: 1,
    flowControl: "none",
    autoReconnect: false,
    tags: [],
    connectSnippet: null,
    ...overrides,
  } as Device;
}

function shell(id: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    name: `shell-${id}`,
    kind: "localShell",
    shell: null,
    cwd: null,
    autoReconnect: false,
    tags: [],
    connectSnippet: null,
    ...overrides,
  } as Device;
}

/** Each fetch waits for its own answer; counts how many wait at once. */
class SlowDevicesPort implements DevicesPort {
  readonly answers: Array<(devices: Device[]) => void> = [];
  maxInFlight = 0;
  private inFlight = 0;

  listDevices(): Promise<Device[]> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise((resolve) => this.answers.push(resolve));
  }

  answer(index: number, devices: Device[]): void {
    this.inFlight -= 1;
    this.answers[index]!(devices);
  }
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
}

const diskError: AppError = { code: "Io", message: "disk" };

describe("DeviceCatalog", () => {
  let port: FakeDevicesPort;
  let onError: ReturnType<typeof vi.fn<(error: AppError) => void>>;
  let catalog: DeviceCatalog;
  let changes: DeviceChange[];

  beforeEach(() => {
    logToBackendMock.mockClear();
    port = new FakeDevicesPort();
    onError = vi.fn();
    catalog = new DeviceCatalog(port, onError);
    changes = [];
    catalog.subscribe((change) => changes.push(change));
  });

  async function loadWith(...devices: Device[]): Promise<void> {
    port.devices = devices;
    await catalog.refresh();
  }

  describe("refresh", () => {
    it("is empty and not loaded before the first refresh", () => {
      expect(catalog.list()).toEqual([]);
      expect(catalog.hasLoaded()).toBe(false);
    });

    it("loads the devices and tells subscribers", async () => {
      await loadWith(ssh("a"), serial("b"));
      expect(catalog.list().map((device) => device.id)).toEqual(["a", "b"]);
      expect(catalog.hasLoaded()).toBe(true);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.devices.map((device) => device.id)).toEqual(["a", "b"]);
    });

    it("finds a device by id", async () => {
      await loadWith(ssh("a"));
      expect(catalog.get("a")?.name).toBe("ssh-a");
      expect(catalog.get("gone")).toBeUndefined();
    });

    it("fetches once more after the running fetch when asked during it", async () => {
      const held = port.hold();
      const first = catalog.refresh();
      await Promise.resolve();
      port.devices = [ssh("new")];
      const second = catalog.refresh();
      const third = catalog.refresh();
      held.release();
      await Promise.all([first, second, third]);
      expect(port.fetchCount).toBe(2);
      expect(catalog.list().map((device) => device.id)).toEqual(["new"]);
    });

    it("keeps the last good list and reports one error when a fetch fails", async () => {
      await loadWith(ssh("a"));
      port.failNext(diskError);
      await catalog.refresh();
      expect(catalog.list().map((device) => device.id)).toEqual(["a"]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(diskError);
      expect(changes).toHaveLength(1);
    });

    it("reports one error for calls sharing a failed follow-up fetch", async () => {
      const held = port.hold();
      const first = catalog.refresh();
      port.failNext(diskError);
      const second = catalog.refresh();
      const third = catalog.refresh();
      held.release();
      await Promise.all([first, second, third]);
      expect(port.fetchCount).toBe(2);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("stays not loaded after a failed first fetch", async () => {
      port.failNext(diskError);
      await catalog.refresh();
      expect(catalog.hasLoaded()).toBe(false);
      expect(changes).toEqual([]);
    });

    it("still tells the other listeners when one throws, and logs it", async () => {
      catalog.subscribe(() => {
        throw new Error("boom");
      });
      const later = vi.fn();
      catalog.subscribe(later);
      await expect(loadWith(ssh("a"))).resolves.toBeUndefined();
      expect(later).toHaveBeenCalledTimes(1);
      expect(logToBackendMock).toHaveBeenCalledWith("error", expect.stringContaining("boom"));
    });

    it("still runs a queued fetch after a listener threw during the running one", async () => {
      catalog.subscribe(() => {
        throw new Error("boom");
      });
      const held = port.hold();
      const first = catalog.refresh();
      const second = catalog.refresh();
      held.release();
      await Promise.allSettled([first, second]);
      port.devices = [ssh("new")];
      await catalog.refresh();
      expect(port.fetchCount).toBe(3);
      expect(catalog.list().map((device) => device.id)).toEqual(["new"]);
    });

    it("fetches fresh for a call made during a fetch whose load rejects", async () => {
      onError.mockImplementationOnce(() => {
        throw new Error("toast failed");
      });
      const held = port.hold();
      const first = catalog.refresh();
      const second = catalog.refresh();
      port.devices = [ssh("new")];
      held.fail(diskError);
      await expect(first).rejects.toThrow("toast failed");
      await second;
      expect(port.fetchCount).toBe(2);
      expect(catalog.list().map((device) => device.id)).toEqual(["new"]);
    });

    it("never runs two fetches at once, so an older list can't land last", async () => {
      const slowPort = new SlowDevicesPort();
      const slow = new DeviceCatalog(slowPort);
      const first = slow.refresh();
      const second = slow.refresh();
      // As the first one settles: after its fetch, before the queued one starts.
      const third = first.then(() => slow.refresh());
      slowPort.answer(0, [ssh("one")]);
      await settle();
      const latest = slowPort.answers.length - 1;
      slowPort.answer(latest, [ssh("latest")]);
      for (let index = 1; index < latest; index++) slowPort.answer(index, [ssh("stale")]);
      await Promise.all([second, third]);
      expect(slowPort.maxInFlight).toBe(1);
      expect(slow.list().map((device) => device.id)).toEqual(["latest"]);
    });

    it("logs the message of a listener's app error", async () => {
      catalog.subscribe(() => {
        throw diskError;
      });
      await loadWith(ssh("a"));
      expect(logToBackendMock).toHaveBeenCalledWith("error", expect.stringContaining("disk"));
    });

    it("returns a copy of a device", async () => {
      await loadWith(ssh("a"));
      catalog.get("a")!.name = "changed";
      expect(catalog.get("a")?.name).toBe("ssh-a");
    });

    it("stops telling a listener once it unsubscribed", async () => {
      const listener = vi.fn();
      const unsubscribe = catalog.subscribe(listener);
      unsubscribe();
      await loadWith(ssh("a"));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("change", () => {
    it("leaves a deleted device out of the list and the changes", async () => {
      await loadWith(ssh("a"), ssh("b"));
      await loadWith(ssh("b"));
      expect(changes[1]!.devices.map((device) => device.id)).toEqual(["b"]);
      expect(changes[1]!.changedIds).toEqual([]);
    });

    it("lists nothing for a first load or an added device", async () => {
      await loadWith(ssh("a"));
      await loadWith(ssh("a"), ssh("b"));
      expect(changes[0]!.changedIds).toEqual([]);
      expect(changes[1]!.changedIds).toEqual([]);
    });

    it.each<[string, Partial<Device>]>([
      ["host", { host: "10.0.0.2" }],
      ["port", { port: 2222 }],
      ["username", { username: "root" } as Partial<Device>],
      ["auth", { auth: { method: "key", keyPath: "/k" } } as Partial<Device>],
      ["jump host", { proxyJump: "jump" } as Partial<Device>],
      ["agent forwarding", { forwardAgent: true } as Partial<Device>],
      ["X11 forwarding", { x11Forwarding: "trusted" } as Partial<Device>],
    ])("counts an SSH %s edit as a connection change", async (_field, edit) => {
      await loadWith(ssh("a"));
      await loadWith(ssh("a", edit));
      expect(changes[1]!.changedIds).toEqual(["a"]);
    });

    it.each<[string, Partial<Device>]>([
      ["port name", { portName: "COM4" } as Partial<Device>],
      ["baud rate", { baudRate: 9600 } as Partial<Device>],
      ["data bits", { dataBits: 7 } as Partial<Device>],
      ["parity", { parity: "even" } as Partial<Device>],
      ["stop bits", { stopBits: 2 } as Partial<Device>],
      ["flow control", { flowControl: "hardware" } as Partial<Device>],
    ])("counts a serial %s edit as a connection change", async (_field, edit) => {
      await loadWith(serial("a"));
      await loadWith(serial("a", edit));
      expect(changes[1]!.changedIds).toEqual(["a"]);
    });

    it.each<[string, Partial<Device>]>([
      ["shell", { shell: "/bin/zsh" } as Partial<Device>],
      ["working directory", { cwd: "/tmp" } as Partial<Device>],
    ])("counts a local shell %s edit as a connection change", async (_field, edit) => {
      await loadWith(shell("a"));
      await loadWith(shell("a", edit));
      expect(changes[1]!.changedIds).toEqual(["a"]);
    });

    it("counts a device whose jump host's connection changed", async () => {
      await loadWith(ssh("jump"), ssh("a", { proxyJump: "jump" } as Partial<Device>), ssh("b"));
      await loadWith(ssh("jump", { host: "10.0.0.9" }), ssh("a", { proxyJump: "jump" } as Partial<Device>), ssh("b"));
      expect(changes[1]!.changedIds).toEqual(["jump", "a"]);
    });

    it.each<[string, Partial<Device>]>([
      ["port", { port: 2222 }],
      ["username", { username: "root" } as Partial<Device>],
      ["auth", { auth: { method: "agent" } } as Partial<Device>],
    ])("counts a device whose jump host's %s changed", async (_field, edit) => {
      await loadWith(ssh("jump"), ssh("a", { proxyJump: "jump" } as Partial<Device>));
      await loadWith(ssh("jump", edit), ssh("a", { proxyJump: "jump" } as Partial<Device>));
      expect(changes[1]!.changedIds).toEqual(["jump", "a"]);
    });

    it.each<[string, Partial<Device>]>([
      ["agent forwarding", { forwardAgent: true } as Partial<Device>],
      ["X11 forwarding", { x11Forwarding: "trusted" } as Partial<Device>],
      ["own jump host", { proxyJump: "other" } as Partial<Device>],
    ])("ignores a jump host's %s edit for the devices behind it", async (_field, edit) => {
      await loadWith(ssh("jump"), ssh("a", { proxyJump: "jump" } as Partial<Device>));
      await loadWith(ssh("jump", edit), ssh("a", { proxyJump: "jump" } as Partial<Device>));
      expect(changes[1]!.changedIds).toEqual(["jump"]);
    });

    it("counts a device whose jump host is no longer an SSH device", async () => {
      await loadWith(ssh("jump"), ssh("a", { proxyJump: "jump" } as Partial<Device>));
      await loadWith(serial("jump"), ssh("a", { proxyJump: "jump" } as Partial<Device>));
      expect(changes[1]!.changedIds).toEqual(["jump", "a"]);
    });

    it("ignores a jump host edit that leaves its connection alone", async () => {
      await loadWith(ssh("jump"), ssh("a", { proxyJump: "jump" } as Partial<Device>));
      await loadWith(ssh("jump", { name: "Renamed" }), ssh("a", { proxyJump: "jump" } as Partial<Device>));
      expect(changes[1]!.changedIds).toEqual([]);
    });

    it("counts a change of device kind as a connection change", async () => {
      await loadWith(ssh("a"));
      await loadWith(shell("a"));
      expect(changes[1]!.changedIds).toEqual(["a"]);
    });

    it("ignores edits that leave the connection alone", async () => {
      await loadWith(ssh("a"));
      await loadWith(
        ssh("a", {
          name: "Renamed",
          tags: ["db"],
          autoReconnect: true,
          connectSnippet: "ls",
          tunnelAutoStart: true,
          forwards: [{ id: "f", name: "f", kind: "local", localAddr: "127.0.0.1", localPort: 1, remoteHost: "h", remotePort: 2 }],
        } as Partial<Device>),
      );
      expect(changes[1]!.changedIds).toEqual([]);
    });
  });
});
