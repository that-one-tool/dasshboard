import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppError, Device, Forward, ForwardStatus, SshDevice, TunnelStatusEvent } from "../ipc";
import { t } from "../i18n";
import { MAX_RECONNECT_ATTEMPTS } from "../terminal/reconnect";
import { FakeTunnelsPort } from "./fakeTunnelsPort.testing";
import { DeviceCatalog } from "../devices/deviceCatalog";
import { FakeDevicesPort } from "../devices/fakeDevicesPort.testing";
import { forwardState, type TunnelRunState } from "./tunnelForwards";
import { TunnelSupervisor } from "./tunnelSupervisor";

function sshDevice(id: string, name: string, forwards: Forward[] = []): Device {
  return {
    id,
    name,
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    auth: { method: "password" },
    forwards,
    tunnelAutoStart: false,
    autoReconnect: false,
  } as Device;
}

function forward(id: string, localPort: number): Forward {
  return { id, name: `fwd-${id}`, kind: "local", localAddr: "127.0.0.1", localPort, remoteHost: "db", remotePort: 5432 };
}

function bound(forwardId: string, isBound = true): ForwardStatus {
  return { forwardId, localAddr: "127.0.0.1", localPort: 5432, remoteHost: "db", remotePort: 5432, bound: isBound };
}

const oneForward = (): Device => sshDevice("dev-1", "NAS", [forward("f1", 5432)]);
const twoForwards = (): Device => sshDevice("dev-1", "NAS", [forward("f1", 5432), forward("f2", 6543)]);
const flagged = (): Device => ({ ...oneForward(), tunnelAutoStart: true }) as Device;
const moved = (): Device => ({ ...twoForwards(), host: "10.0.0.2" }) as Device;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("TunnelSupervisor", () => {
  let port: FakeTunnelsPort;
  let devicesPort: FakeDevicesPort;
  let catalog: DeviceCatalog;
  let onError: ReturnType<typeof vi.fn<(error: AppError) => void>>;
  let onPersist: ReturnType<typeof vi.fn<() => void>>;
  let supervisor: TunnelSupervisor;

  beforeEach(() => {
    port = new FakeTunnelsPort();
    devicesPort = new FakeDevicesPort();
    catalog = new DeviceCatalog(devicesPort);
    devicesPort.devices = [oneForward()];
    onError = vi.fn();
    onPersist = vi.fn();
  });

  afterEach(() => supervisor?.dispose());

  function create(initialState?: TunnelRunState): TunnelSupervisor {
    supervisor = new TunnelSupervisor(port, catalog, { initialState, onError, onPersist });
    return supervisor;
  }

  async function launch(initialState?: TunnelRunState): Promise<TunnelSupervisor> {
    await catalog.refresh();
    create(initialState);
    await supervisor.init();
    await flush();
    return supervisor;
  }

  function device(): SshDevice {
    return supervisor.tunnelableDevices()[0]!;
  }

  async function startAll(): Promise<void> {
    supervisor.startDevice(device());
    await flush();
  }

  async function click(action: () => void): Promise<void> {
    action();
    await flush();
  }

  function listening(...forwards: ForwardStatus[]): void {
    port.emit({ tunnelId: port.lastTunnelId(), status: "listening", forwards });
  }

  function ended(tunnelId: string, status: "disconnected" | "error" = "disconnected", code?: string): void {
    port.emit({ tunnelId, status, message: "lost", code, forwards: [] } as TunnelStatusEvent);
  }

  function dot(forwardId: string): string {
    return forwardState(supervisor.activeState("dev-1"), forwardId);
  }

  function status(): string {
    return supervisor.activeState("dev-1")?.status ?? "stopped";
  }

  describe("launch", () => {
    it("lists only tunnelable devices", async () => {
      devicesPort.devices = [oneForward(), sshDevice("dev-2", "NoForwards", [])];
      await launch();
      expect(supervisor.tunnelableDevices().map((d) => d.id)).toEqual(["dev-1"]);
    });

    it("auto-starts a flagged device's tunnel", async () => {
      devicesPort.devices = [flagged()];
      await launch();
      expect(port.calls).toEqual(["start dev-1 t1 f1"]);
    });

    it("does not auto-start an unflagged device", async () => {
      await launch();
      expect(port.calls).toEqual([]);
    });

    it("does not auto-start a flagged device that is already running", async () => {
      devicesPort.devices = [flagged()];
      port.tunnels = [{ tunnelId: "existing", deviceId: "dev-1", forwardIds: ["f1"], forwards: [bound("f1")] }];
      await launch();
      expect(port.calls).toEqual([]);
    });

    it("does not restart a flagged tunnel the user left stopped", async () => {
      devicesPort.devices = [flagged()];
      await launch({ "dev-1": false });
      expect(port.calls).toEqual([]);
    });

    it("restarts an unflagged tunnel the user left running", async () => {
      await launch({ "dev-1": true });
      expect(port.calls).toEqual(["start dev-1 t1 f1"]);
    });

    it("restores only the forwards the user left running", async () => {
      devicesPort.devices = [twoForwards()];
      await launch({ "dev-1": ["f2"] });
      expect(port.calls).toEqual(["start dev-1 t1 f2"]);
    });

    it("shows an already-running tunnel's forwards as they are", async () => {
      devicesPort.devices = [twoForwards()];
      port.tunnels = [{ tunnelId: "existing", deviceId: "dev-1", forwardIds: ["f2"], forwards: [bound("f2")] }];
      await launch();
      expect(dot("f1")).toBe("stopped");
      expect(dot("f2")).toBe("listening");
    });

    it("shows a tunnel adopted while still connecting as connecting", async () => {
      devicesPort.devices = [twoForwards()];
      port.tunnels = [{ tunnelId: "existing", deviceId: "dev-1", forwardIds: ["f2"], forwards: [] }];
      await launch();
      expect(dot("f2")).toBe("connecting");
      expect(status()).toBe("connecting");
    });

    it("starts with nothing running when the tunnel list fails", async () => {
      port.failNext("listTunnels", { code: "Io", message: "ipc" });
      await launch();
      expect(supervisor.activeState("dev-1")).toBeUndefined();
      expect(port.isSubscribed).toBe(true);
    });

    it("tells its listeners once the launch state is in", async () => {
      const changed = vi.fn();
      create().onChanged(changed);
      await supervisor.init();
      expect(changed).toHaveBeenCalled();
    });
  });

  describe("remembered run state", () => {
    it("remembers a manual stop and asks for a save", async () => {
      devicesPort.devices = [flagged()];
      await launch();
      await click(() => supervisor.stopDevice("dev-1"));
      expect(port.calls).toEqual(["start dev-1 t1 f1", "stop t1"]);
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
      expect(onPersist).toHaveBeenCalled();
    });

    it("remembers a manual start", async () => {
      await launch();
      await startAll();
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f1"] });
    });

    it("an auto-start alone records nothing (the flag stays the default)", async () => {
      devicesPort.devices = [flagged()];
      await launch();
      expect(supervisor.layoutState()).toBeUndefined();
    });

    it("forgets remembered state for devices that are gone", async () => {
      await launch({ "dev-1": false, ghost: true });
      expect(port.calls).toEqual([]);
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
    });

    it("keeps the restored state until the device list has loaded", () => {
      create({ "dev-1": false });
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
    });

    it("applies a device list the catalog loads after a failed launch load", async () => {
      devicesPort.failNext({ code: "Io", message: "boom" });
      await catalog.refresh();
      create({ "dev-1": false });
      await supervisor.init();
      expect(supervisor.tunnelableDevices()).toEqual([]);
      await catalog.refresh();
      await flush();
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
      expect(supervisor.tunnelableDevices().map((d) => d.id)).toEqual(["dev-1"]);
    });

    it("a failed device load at launch keeps the remembered state and reports nothing itself", async () => {
      devicesPort.failNext({ code: "Io", message: "disk" });
      await catalog.refresh();
      create({ "dev-1": false });
      await supervisor.init();
      await flush();
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
      expect(onError).not.toHaveBeenCalled();
    });

    it("a failed device refresh stops nothing and forgets nothing", async () => {
      await launch({ "dev-1": true });
      devicesPort.failNext({ code: "Io", message: "disk" });
      await catalog.refresh();
      await flush();
      expect(port.calls).toEqual(["start dev-1 t1 f1"]);
      expect(supervisor.layoutState()).toEqual({ "dev-1": true });
    });

    it("stops following the catalog once disposed", async () => {
      await launch();
      supervisor.dispose();
      devicesPort.devices = [];
      await catalog.refresh();
      expect(supervisor.tunnelableDevices().map((d) => d.id)).toEqual(["dev-1"]);
    });

    it("a refresh applies the reloaded device list", async () => {
      await launch();
      devicesPort.devices = [];
      await catalog.refresh();
      expect(supervisor.tunnelableDevices()).toEqual([]);
    });

    it("a Start the backend rejects is remembered as stopped (no retry every launch)", async () => {
      port.failNext("startTunnel", { code: "Validation", message: "ProxyJump" });
      await launch({ "dev-1": true });
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
      expect(onError).toHaveBeenCalledWith({ code: "Validation", message: "ProxyJump" });
    });

    it("remembers a Start only once it succeeded", async () => {
      await launch();
      const start = port.hold("startTunnel");
      await startAll();
      expect(supervisor.layoutState()).toBeUndefined();
      start.release();
      await flush();
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f1"] });
    });
  });

  describe("live status", () => {
    it("reflects a listening event and tells its listeners", async () => {
      await launch();
      await startAll();
      const changed = vi.fn();
      supervisor.onChanged(changed);
      listening(bound("f1"));
      expect(status()).toBe("listening");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(supervisor.listeningForwardCount()).toBe(1);
    });

    it("colors each forward from the live bind state", async () => {
      devicesPort.devices = [twoForwards()];
      await launch();
      await startAll();
      expect(port.calls).toEqual(["start dev-1 t1 f1,f2"]);
      listening(bound("f1"), bound("f2", false));
      expect(dot("f1")).toBe("listening");
      expect(dot("f2")).toBe("unbound");
    });

    it("ignores events of tunnels it does not know", async () => {
      await launch();
      await startAll();
      const changed = vi.fn();
      supervisor.onChanged(changed);
      port.emit({ tunnelId: "stranger", status: "listening", forwards: [bound("f1")] });
      expect(dot("f1")).toBe("connecting");
      expect(changed).not.toHaveBeenCalled();
    });

    it("honors an error that arrives before the start returns", async () => {
      await launch();
      const start = port.hold("startTunnel");
      await startAll();
      port.emit({ tunnelId: "t1", status: "error", message: "connection refused", forwards: [] });
      start.release();
      await flush();
      expect(onError).toHaveBeenCalledWith({ code: "TunnelBind", message: "connection refused" });
      expect(status()).toBe("stopped");
    });

    it("reports an error without message with the generic text", async () => {
      await launch();
      await startAll();
      port.emit({ tunnelId: "t1", status: "error", forwards: [] });
      expect(onError).toHaveBeenCalledWith({ code: "TunnelBind", message: t("tunnels.error.generic") });
    });

    it("forgets a tunnel that disconnected, without an error", async () => {
      await launch();
      await startAll();
      ended("t1");
      expect(status()).toBe("stopped");
      expect(onError).not.toHaveBeenCalled();
    });

    it("stops counting a deleted device's forwards before the backend confirms the stop", async () => {
      await launch();
      await startAll();
      listening(bound("f1"));
      supervisor.setDevices([]);
      expect(supervisor.listeningForwardCount()).toBe(0);
    });
  });

  describe("orphaned tunnels", () => {
    async function running(): Promise<void> {
      await launch();
      await startAll();
      port.calls.length = 0;
    }

    it("stops a running tunnel whose device was deleted", async () => {
      await running();
      await click(() => supervisor.setDevices([]));
      expect(port.calls).toEqual(["stop t1"]);
    });

    it("stops a running tunnel whose device lost all its forwards", async () => {
      await running();
      await click(() => supervisor.setDevices([sshDevice("dev-1", "NAS", [])]));
      expect(port.calls).toEqual(["stop t1"]);
    });

    it("leaves a running tunnel alone when its device still has forwards", async () => {
      await running();
      await click(() => supervisor.setDevices([sshDevice("dev-1", "Renamed", [forward("f1", 5432)])]));
      expect(port.calls).toEqual([]);
    });

    it("stops a tunnel whose device was deleted while it was starting", async () => {
      await launch();
      const start = port.hold("startTunnel");
      await startAll();
      supervisor.setDevices([]);
      start.release();
      await flush();
      expect(port.calls).toContain("stop t1");
    });
  });

  describe("per-forward Start/Stop", () => {
    beforeEach(() => {
      devicesPort.devices = [twoForwards()];
    });

    async function runningWith(...forwardIds: string[]): Promise<void> {
      await launch();
      if (forwardIds.length === 2) await startAll();
      else await click(() => supervisor.startForward("dev-1", forwardIds[0]!));
      listening(...forwardIds.map((id) => bound(id)));
      port.calls.length = 0;
    }

    it("starts a tunnel carrying only the forward started", async () => {
      await launch();
      await click(() => supervisor.startForward("dev-1", "f2"));
      expect(port.calls).toEqual(["start dev-1 t1 f2"]);
      expect(dot("f2")).toBe("connecting");
      expect(dot("f1")).toBe("stopped");
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f2"] });
    });

    it("binds a forward on the running tunnel instead of opening another", async () => {
      await runningWith("f1");
      await click(() => supervisor.startForward("dev-1", "f2"));
      expect(port.calls).toEqual(["bind t1 f2"]);
      expect(dot("f2")).toBe("connecting");
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f1", "f2"] });
    });

    it("a re-bound forward shows connecting, not its stale bind state", async () => {
      await runningWith("f1", "f2");
      await click(() => supervisor.stopForward("dev-1", "f2"));
      await click(() => supervisor.startForward("dev-1", "f2"));
      expect(dot("f2")).toBe("connecting");
    });

    it("releases one forward and keeps the others running", async () => {
      await runningWith("f1", "f2");
      await click(() => supervisor.stopForward("dev-1", "f1"));
      expect(port.calls).toEqual(["unbind t1 f1"]);
      expect(dot("f1")).toBe("stopped");
      expect(supervisor.activeState("dev-1")).toBeDefined();
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f2"] });
    });

    it("stopping the last running forward stops the tunnel", async () => {
      await runningWith("f1");
      await click(() => supervisor.stopForward("dev-1", "f1"));
      expect(port.calls).toEqual(["stop t1"]);
      expect(supervisor.activeState("dev-1")).toBeUndefined();
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
    });

    it("Stop all stops the tunnel with every forward", async () => {
      await runningWith("f1");
      await click(() => supervisor.stopDevice("dev-1"));
      expect(port.calls).toEqual(["stop t1"]);
      expect(dot("f1")).toBe("stopped");
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
    });

    it("a Stop of a stopped device or forward does nothing", async () => {
      await launch();
      await click(() => supervisor.stopDevice("dev-1"));
      await click(() => supervisor.stopForward("dev-1", "f1"));
      expect(port.calls).toEqual([]);
      expect(onPersist).not.toHaveBeenCalled();
    });

    it("a forward started while the tunnel is still starting is bound once it has", async () => {
      await launch();
      const start = port.hold("startTunnel");
      await click(() => supervisor.startForward("dev-1", "f1"));
      await click(() => supervisor.startForward("dev-1", "f2"));
      expect(port.calls).toEqual(["start dev-1 t1 f1"]);
      start.release();
      await flush();
      expect(port.calls).toEqual(["start dev-1 t1 f1", "bind t1 f2"]);
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f1", "f2"] });
    });

    it("a forward stopped while the tunnel is still starting is released once it has", async () => {
      await launch();
      const start = port.hold("startTunnel");
      await startAll();
      await click(() => supervisor.stopForward("dev-1", "f1"));
      start.release();
      await flush();
      expect(port.calls).toEqual(["start dev-1 t1 f1,f2", "unbind t1 f1"]);
    });

    it("a forward the backend refuses to bind goes back to stopped", async () => {
      await runningWith("f1");
      port.failNext("startTunnelForward", { code: "Validation", message: "gone" });
      await click(() => supervisor.startForward("dev-1", "f2"));
      expect(onError).toHaveBeenCalledWith({ code: "Validation", message: "gone" });
      expect(dot("f2")).toBe("stopped");
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f1"] });
    });

    it("releases a running forward that was deleted from its device", async () => {
      await runningWith("f1", "f2");
      await click(() => supervisor.setDevices([oneForward()]));
      expect(port.calls).toEqual(["unbind t1 f2"]);
    });

    it("stops the tunnel when every running forward was deleted", async () => {
      await runningWith("f2");
      await click(() => supervisor.setDevices([oneForward()]));
      expect(port.calls).toEqual(["stop t1"]);
      expect(dot("f1")).toBe("stopped");
    });

    it("stops a tunnel replaced while its start was in flight (Start, Stop, Start)", async () => {
      await launch();
      const firstStart = port.hold("startTunnel");
      await click(() => supervisor.startForward("dev-1", "f1"));
      await click(() => supervisor.stopForward("dev-1", "f1"));
      await click(() => supervisor.startForward("dev-1", "f1"));
      port.calls.length = 0;
      firstStart.release();
      await flush();
      expect(port.calls).toEqual(["stop t1"]);
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f1"] });
    });

    it("a Stop while the start is in flight takes effect once it has started", async () => {
      devicesPort.devices = [oneForward()];
      await launch();
      const start = port.hold("startTunnel");
      await startAll();
      await click(() => supervisor.stopDevice("dev-1"));
      port.calls.length = 0;
      start.release();
      await flush();
      expect(port.calls).toEqual(["stop t1"]);
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
    });

    it("sends a device's forward changes to the backend in click order", async () => {
      await runningWith("f2");
      const bind = port.hold("startTunnelForward");
      await click(() => supervisor.startForward("dev-1", "f1"));
      await click(() => supervisor.stopForward("dev-1", "f2"));
      expect(port.calls).toEqual(["bind t1 f1"]);
      bind.release();
      await flush();
      expect(port.calls).toEqual(["bind t1 f1", "unbind t1 f2"]);
    });

    it("puts the forwards back when Stop all fails", async () => {
      await runningWith("f1");
      port.failNext("stopTunnel", { code: "Io", message: "ipc" });
      await click(() => supervisor.stopDevice("dev-1"));
      expect(onError).toHaveBeenCalled();
      expect(dot("f1")).toBe("listening");
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f1"] });
    });

    it("puts a forward back when its Stop fails", async () => {
      await runningWith("f1", "f2");
      port.failNext("stopTunnelForward", { code: "Io", message: "ipc" });
      await click(() => supervisor.stopForward("dev-1", "f1"));
      expect(onError).toHaveBeenCalled();
      expect(dot("f1")).toBe("listening");
    });

    it("a failed stop of a tunnel that has since ended puts nothing back", async () => {
      await runningWith("f1");
      const stop = port.hold("stopTunnel");
      await click(() => supervisor.stopDevice("dev-1"));
      ended("t1");
      stop.fail({ code: "Io", message: "ipc" });
      await flush();
      expect(supervisor.activeState("dev-1")).toBeUndefined();
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
    });
  });

  describe("device edits", () => {
    beforeEach(() => {
      devicesPort.devices = [twoForwards()];
    });

    async function runningWith(...forwardIds: string[]): Promise<void> {
      await launch();
      if (forwardIds.length === 2) await startAll();
      else await click(() => supervisor.startForward("dev-1", forwardIds[0]!));
      listening(...forwardIds.map((id) => bound(id)));
      port.calls.length = 0;
    }

    it("restarts a running tunnel whose connection settings changed", async () => {
      await runningWith("f2");
      await click(() => supervisor.setDevices([moved()]));
      expect(port.calls).toEqual(["stop t1"]); // waits for the old one to let go
      expect(dot("f2")).toBe("connecting");

      ended("t1");
      await flush();
      expect(port.calls).toEqual(["stop t1", "start dev-1 t2 f2"]);
      expect(dot("f2")).toBe("connecting");
    });

    it("a restarting tunnel keeps showing connecting whatever it reports", async () => {
      await runningWith("f2");
      await click(() => supervisor.setDevices([moved()]));
      listening(bound("f2"));
      expect(dot("f2")).toBe("connecting");
    });

    it("stops, never restarts direct, a running tunnel whose jump host was removed", async () => {
      const jumped = { ...twoForwards(), proxyJump: "bastion" } as Device;
      devicesPort.devices = [jumped];
      await runningWith("f2");
      await click(() => supervisor.setDevices([{ ...jumped, proxyJump: null } as Device]));
      expect(port.calls).toEqual(["stop t1"]);
      expect(onError).toHaveBeenCalledWith({
        code: "Validation",
        message: t("tunnels.error.jumpRemoved", { name: "NAS" }),
      });

      ended("t1");
      await flush();
      expect(port.calls).toEqual(["stop t1"]);
      expect(dot("f2")).toBe("stopped");
      expect(supervisor.layoutState()).toEqual({ "dev-1": false });
    });

    it("a forward stopped while restarting is left out of the restart", async () => {
      await runningWith("f1", "f2");
      await click(() => supervisor.setDevices([moved()]));
      await click(() => supervisor.stopForward("dev-1", "f1"));
      expect(port.calls).toEqual(["stop t1"]);

      ended("t1");
      await flush();
      expect(port.calls).toEqual(["stop t1", "start dev-1 t2 f2"]);
    });

    it("a Stop all while restarting leaves the tunnel stopped", async () => {
      await runningWith("f2");
      await click(() => supervisor.setDevices([moved()]));
      await click(() => supervisor.stopDevice("dev-1"));
      ended("t1");
      await flush();
      expect(port.calls.filter((call) => call.startsWith("start"))).toEqual([]);
      expect(status()).toBe("stopped");
    });

    it("a device deleted while restarting is not restarted", async () => {
      await runningWith("f2");
      await click(() => supervisor.setDevices([moved()]));
      await click(() => supervisor.setDevices([]));
      ended("t1");
      await flush();
      expect(port.calls.filter((call) => call.startsWith("start"))).toEqual([]);
    });

    it("an edit while starting stops the new tunnel and restarts it once started", async () => {
      await launch();
      const start = port.hold("startTunnel");
      await click(() => supervisor.startForward("dev-1", "f2"));
      await click(() => supervisor.setDevices([moved()]));
      expect(port.calls).toEqual(["start dev-1 t1 f2", "stop t1"]);
      start.release();
      await flush();
      expect(port.calls).toEqual(["start dev-1 t1 f2", "stop t1", "stop t1"]);
      ended("t1");
      await flush();
      expect(port.calls.at(-1)).toBe("start dev-1 t2 f2");
    });

    it("does not restart a tunnel for a cosmetic device edit", async () => {
      await runningWith("f1");
      await click(() => supervisor.setDevices([{ ...twoForwards(), name: "Renamed", tags: ["db"] } as Device]));
      expect(port.calls).toEqual([]);
    });

    it("re-binds a running forward whose ports were edited", async () => {
      await runningWith("f1");
      await click(() => supervisor.setDevices([sshDevice("dev-1", "NAS", [forward("f1", 15432), forward("f2", 6543)])]));
      expect(port.calls).toEqual(["bind t1 f1"]);
      expect(dot("f1")).toBe("connecting");
    });

    it("tells its listeners about a new device list", async () => {
      await launch();
      const changed = vi.fn();
      supervisor.onChanged(changed);
      supervisor.setDevices([]);
      expect(changed).toHaveBeenCalled();
    });
  });

  describe("auto-reconnect", () => {
    const reconnecting = (): Device => ({ ...oneForward(), autoReconnect: true }) as Device;

    async function runningTunnel(): Promise<void> {
      await launch();
      await startAll();
      listening(bound("f1"));
      port.calls.length = 0;
    }

    function lost(code = "SshConnect"): void {
      ended(port.lastTunnelId(), "error", code);
    }

    beforeEach(() => {
      vi.useFakeTimers();
      devicesPort.devices = [reconnecting()];
    });
    afterEach(() => vi.useRealTimers());

    it("reconnects a dropped tunnel of a device that opted in, with the same forwards", async () => {
      await runningTunnel();
      lost();
      expect(status()).toBe("connecting");
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(port.calls).toEqual(["start dev-1 t2 f1"]);
    });

    it("leaves a dropped tunnel stopped when its device did not opt in", async () => {
      devicesPort.devices = [oneForward()];
      await runningTunnel();
      lost();
      await vi.runAllTimersAsync();
      expect(port.calls).toEqual([]);
      expect(onError).toHaveBeenCalled();
      expect(status()).toBe("stopped");
    });

    it("never retries a tunnel the server refused to authenticate", async () => {
      await runningTunnel();
      lost("SshAuth");
      await vi.runAllTimersAsync();
      expect(port.calls).toEqual([]);
      expect(onError).toHaveBeenCalled();
    });

    it("ignores later events of the dropped tunnel while waiting", async () => {
      await runningTunnel();
      lost();
      listening(bound("f1"));
      expect(status()).toBe("connecting");
    });

    it("a Stop while waiting to reconnect keeps the tunnel stopped", async () => {
      await runningTunnel();
      lost();
      supervisor.stopDevice("dev-1");
      await vi.runAllTimersAsync();
      await flush();
      expect(port.calls.filter((call) => call.startsWith("start"))).toEqual([]);
      expect(status()).toBe("stopped");
    });

    it("a forward stopped while waiting is left out of the reconnect", async () => {
      devicesPort.devices = [{ ...twoForwards(), autoReconnect: true } as Device];
      await launch();
      await startAll();
      listening(bound("f1"), bound("f2"));
      port.calls.length = 0;

      lost();
      supervisor.stopForward("dev-1", "f2");
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(port.calls).toEqual(["start dev-1 t2 f1"]);
    });

    it("a forward started while waiting joins the reconnect", async () => {
      devicesPort.devices = [{ ...twoForwards(), autoReconnect: true } as Device];
      await launch();
      await click(() => supervisor.startForward("dev-1", "f1"));
      listening(bound("f1"));
      port.calls.length = 0;

      lost();
      supervisor.startForward("dev-1", "f2");
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(port.calls).toEqual(["start dev-1 t2 f1,f2"]);
    });

    it("a device deleted while waiting is not reopened", async () => {
      await runningTunnel();
      lost();
      supervisor.setDevices([]);
      await vi.runAllTimersAsync();
      await flush();
      expect(port.calls.filter((call) => call.startsWith("start"))).toEqual([]);
      expect(supervisor.activeState("dev-1")).toBeUndefined();
    });

    it("a reconnect the backend rejects for good is not remembered as a stop", async () => {
      await runningTunnel();
      port.failNext("startTunnel", { code: "NotFound", message: "gone" });
      lost();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(supervisor.layoutState()).toEqual({ "dev-1": ["f1"] });
    });

    it("a reconnect the backend rejects with a passing error waits to retry", async () => {
      await runningTunnel();
      port.failNext("startTunnel", { code: "SshConnect", message: "down" });
      lost();
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(status()).toBe("connecting");
      expect(onError).not.toHaveBeenCalled();
    });

    it("Stop all then Start all while waiting starts one tunnel, not two", async () => {
      await runningTunnel();
      lost();
      await click(() => supervisor.stopDevice("dev-1"));
      await startAll();
      await vi.runAllTimersAsync();
      await flush();
      expect(port.calls.filter((call) => call.startsWith("start"))).toHaveLength(1);
    });

    it("a connection edit while waiting is picked up by the reconnect, not a restart", async () => {
      await runningTunnel();
      lost();
      await click(() => supervisor.setDevices([{ ...reconnecting(), host: "10.0.0.2" } as Device]));
      expect(port.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(2000);
      await flush();
      expect(port.calls).toEqual(["start dev-1 t2 f1"]);
    });

    it("dispose cancels a pending reconnect", async () => {
      await runningTunnel();
      lost();
      supervisor.dispose();
      await vi.runAllTimersAsync();
      expect(port.calls).toEqual([]);
    });

    it("keeps retrying while the server stays unreachable, then reports it", async () => {
      await runningTunnel();
      for (let attempt = 0; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        lost();
        await vi.runAllTimersAsync();
        await flush();
      }
      expect(port.calls).toHaveLength(MAX_RECONNECT_ATTEMPTS);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(status()).toBe("stopped");
    });

    it("a tunnel back up gets a full budget for its next drop", async () => {
      await runningTunnel();
      for (let round = 0; round < 2 * MAX_RECONNECT_ATTEMPTS; round++) {
        lost();
        await vi.runAllTimersAsync();
        await flush();
        listening(bound("f1"));
      }
      port.calls.length = 0;
      lost();
      await vi.runAllTimersAsync();
      expect(port.calls).toHaveLength(1);
    });
  });

  describe("change notifications", () => {
    let changed: ReturnType<typeof vi.fn<() => void>>;

    function watch(): void {
      changed = vi.fn();
      supervisor.onChanged(changed);
    }

    async function settle(release: () => void): Promise<void> {
      changed.mockClear();
      release();
      await flush();
    }

    it("tells its listeners once a start succeeded", async () => {
      await launch();
      const start = port.hold("startTunnel");
      await startAll();
      watch();
      await settle(() => start.release());
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it("tells its listeners once a start failed", async () => {
      await launch();
      const start = port.hold("startTunnel");
      await startAll();
      watch();
      await settle(() => start.fail({ code: "Io", message: "ipc" }));
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it("tells its listeners once a stop failed", async () => {
      await launch();
      await startAll();
      listening(bound("f1"));
      const stop = port.hold("stopTunnel");
      await click(() => supervisor.stopDevice("dev-1"));
      watch();
      await settle(() => stop.fail({ code: "Io", message: "ipc" }));
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it("tells its listeners once a forward bind failed", async () => {
      devicesPort.devices = [twoForwards()];
      await launch();
      await click(() => supervisor.startForward("dev-1", "f1"));
      listening(bound("f1"));
      const bind = port.hold("startTunnelForward");
      await click(() => supervisor.startForward("dev-1", "f2"));
      watch();
      await settle(() => bind.fail({ code: "TunnelBind", message: "port in use" }));
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it("tells its listeners once a tunnel ended", async () => {
      await launch();
      await startAll();
      watch();
      ended("t1");
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it("tells its listeners when a reconnect timer fires", async () => {
      vi.useFakeTimers();
      devicesPort.devices = [{ ...oneForward(), autoReconnect: true } as Device];
      await launch();
      await startAll();
      listening(bound("f1"));
      ended("t1", "error", "SshConnect");
      watch();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      expect(port.calls).toEqual(["start dev-1 t1 f1", "start dev-1 t2 f1"]);
      expect(changed).toHaveBeenCalled();
    });
  });

  describe("status subscription", () => {
    it("stops listening when disposed before the subscription is in", async () => {
      const subscription = port.hold("onTunnelStatus");
      await launch();
      supervisor.dispose();
      subscription.release();
      await flush();
      expect(port.isSubscribed).toBe(false);
    });

    it("reports a failed subscription instead of leaving it unhandled", async () => {
      port.failNext("onTunnelStatus", { code: "Io", message: "listen" });
      await launch();
      expect(onError).toHaveBeenCalledWith({ code: "Io", message: "listen" });
    });
  });
});
