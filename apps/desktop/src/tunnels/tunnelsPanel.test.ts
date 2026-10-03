/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Device, Forward, TunnelStatusEvent } from "../ipc";

const h = vi.hoisted(() => ({
  devices: [] as Device[],
  statusHandler: null as ((e: TunnelStatusEvent) => void) | null,
}));

vi.mock("../ipc", () => ({
  listDevices: vi.fn(async () => h.devices),
  listTunnels: vi.fn(async () => []),
  startTunnel: vi.fn(async (_deviceId: string, tunnelId: string) => tunnelId),
  stopTunnel: vi.fn(async () => {}),
  startTunnelForward: vi.fn(async () => {}),
  stopTunnelForward: vi.fn(async () => {}),
  onTunnelStatus: vi.fn(async (handler: (e: TunnelStatusEvent) => void) => {
    h.statusHandler = handler;
    return () => {};
  }),
}));

import {
  TunnelsPanel,
  tunnelableDevices,
  statusLabel,
  forwardEndpoint,
  forwardState,
  forwardIdsToRun,
  runChoiceOf,
} from "./tunnelsPanel";
import {
  listDevices,
  listTunnels,
  startTunnel,
  stopTunnel,
  startTunnelForward,
  stopTunnelForward,
  type ForwardStatus,
  type SshDevice,
} from "../ipc";

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
  return {
    id,
    name: `fwd-${id}`,
    kind: "local",
    localAddr: "127.0.0.1",
    localPort,
    remoteHost: "db",
    remotePort: 5432,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("pure helpers", () => {
  it("tunnelableDevices keeps only SSH devices with forwards", () => {
    const devices = [
      sshDevice("a", "A", [forward("f1", 5432)]),
      sshDevice("b", "B", []),
      { id: "s", name: "serial", kind: "serial" } as unknown as Device,
    ];
    const result = tunnelableDevices(devices);
    expect(result.map((d) => d.id)).toEqual(["a"]);
  });

  it("statusLabel maps every status", () => {
    expect(statusLabel("connecting")).toBe("Connecting…");
    expect(statusLabel("listening")).toBe("Listening");
    expect(statusLabel("error")).toBe("Error");
    expect(statusLabel("stopped")).toBe("Stopped");
    expect(statusLabel("disconnected")).toBe("Stopped");
  });

  it("forwardEndpoint formats local → remote", () => {
    expect(
      forwardEndpoint({
        kind: "local",
        localAddr: "127.0.0.1",
        localPort: 5432,
        remoteHost: "db",
        remotePort: 6543,
      }),
    ).toBe("127.0.0.1:5432 → db:6543");
  });

  it("forwardEndpoint shows a dynamic forward as a SOCKS proxy", () => {
    expect(
      forwardEndpoint({
        kind: "dynamic",
        localAddr: "127.0.0.1",
        localPort: 1080,
        remoteHost: "",
        remotePort: 0,
      }),
    ).toBe("127.0.0.1:1080 → SOCKS proxy");
  });
});

function bound(forwardId: string, isBound = true): ForwardStatus {
  return {
    forwardId,
    localAddr: "127.0.0.1",
    localPort: 5432,
    remoteHost: "db",
    remotePort: 5432,
    bound: isBound,
  };
}

describe("per-forward state helpers", () => {
  const live = {
    tunnelId: "t1",
    status: "listening" as const,
    requested: new Set(["f1", "f2", "f3"]),
    forwards: [bound("f1"), bound("f2", false)],
  };

  it("forwardState maps a forward to its dot color state", () => {
    expect(forwardState(undefined, "f1")).toBe("stopped");
    expect(forwardState(live, "f1")).toBe("listening");
    expect(forwardState(live, "f2")).toBe("unbound");
    expect(forwardState(live, "f3")).toBe("connecting"); // asked for, not reported yet
    expect(forwardState(live, "f4")).toBe("stopped"); // not asked for
  });

  const device = sshDevice("dev-1", "NAS", [forward("f1", 1), forward("f2", 2)]) as SshDevice;

  it("forwardIdsToRun reads a remembered choice, else the auto-start flag", () => {
    expect(forwardIdsToRun(device, true)).toEqual(["f1", "f2"]);
    expect(forwardIdsToRun(device, false)).toEqual([]);
    expect(forwardIdsToRun(device, ["f2", "gone"])).toEqual(["f2"]);
    expect(forwardIdsToRun(device, undefined)).toEqual([]);
    expect(forwardIdsToRun({ ...device, tunnelAutoStart: true }, undefined)).toEqual(["f1", "f2"]);
  });

  it("runChoiceOf records all, none, or the listed forwards", () => {
    expect(runChoiceOf(device, new Set(["f2", "f1"]))).toEqual(["f1", "f2"]);
    expect(runChoiceOf(device, new Set())).toBe(false);
    expect(runChoiceOf(device, new Set(["f2"]))).toEqual(["f2"]);
  });
});

describe("TunnelsPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="tunnel-list"></div>';
    h.statusHandler = null;
    vi.clearAllMocks();
    h.devices = [sshDevice("dev-1", "NAS", [forward("f1", 5432)])];
    vi.spyOn(crypto, "randomUUID").mockReturnValue("t1" as ReturnType<typeof crypto.randomUUID>);
  });

  it("renders a card only for tunnelable devices", async () => {
    h.devices = [
      sshDevice("dev-1", "NAS", [forward("f1", 5432)]),
      sshDevice("dev-2", "NoForwards", []),
    ];
    const panel = new TunnelsPanel();
    await panel.init();
    expect(listDevices).toHaveBeenCalled();
    const cards = document.querySelectorAll(".tunnel-card");
    expect(cards).toHaveLength(1);
    expect(document.querySelector(".tunnel-card-name")!.textContent).toBe("NAS");
  });

  it("renders the card into the .tunnel-list sidebar section with a header", async () => {
    const panel = new TunnelsPanel();
    await panel.init();
    const card = document.querySelector(".tunnel-list .tunnel-manager");
    expect(card).not.toBeNull();
    expect(
      document.querySelector(".tunnel-list .device-list-header h2")!.textContent,
    ).toBe("Tunnels");
  });

  it("starts a tunnel on the Start button", async () => {
    const panel = new TunnelsPanel();
    await panel.init();
    document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!.click();
    await flush();
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1", ["f1"]);
  });

  it("reflects a listening event and stops on the Stop button", async () => {
    const panel = new TunnelsPanel();
    await panel.init();
    document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!.click();
    await flush();

    // Backend confirms the tunnel is listening.
    h.statusHandler!({
      tunnelId: "t1",
      status: "listening",
      forwards: [
        {
          forwardId: "f1",
          localAddr: "127.0.0.1",
          localPort: 5432,
          remoteHost: "db",
          remotePort: 5432,
          bound: true,
        },
      ],
    });

    const status = document.querySelector<HTMLElement>(".tunnel-status")!;
    expect(status.classList.contains("is-listening")).toBe(true);
    expect(status.getAttribute("aria-label")).toBe("Listening");
    const action = document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!;
    expect(action.getAttribute("aria-label")).toBe("Stop all");

    action.click();
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
  });

  it("shows a stopped tunnel as an icon status and icon-only buttons", async () => {
    const panel = new TunnelsPanel();
    await panel.init();

    const status = document.querySelector<HTMLElement>(".tunnel-status")!;
    expect(status.classList.contains("is-stopped")).toBe(true);
    expect(status.getAttribute("aria-label")).toBe("Stopped");
    expect(status.title).toBe("Stopped");
    expect(status.querySelector("svg")).not.toBeNull();

    const start = document.querySelector<HTMLButtonElement>(".tunnel-card-header .btn")!;
    expect(start.classList.contains("btn-icon")).toBe(true);
    expect(start.getAttribute("aria-label")).toBe("Start all");
    expect(start.title).toBe("Start all");
    expect(start.textContent!.trim()).toBe("");

    const copy = document.querySelector<HTMLButtonElement>(".tunnel-forward .tunnel-copy")!;
    expect(copy.classList.contains("btn-icon")).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Copy the local address:port");
    expect(copy.textContent!.trim()).toBe("");
  });

  it("shows each forward's name above its endpoint", async () => {
    const panel = new TunnelsPanel();
    await panel.init();
    const row = document.querySelector<HTMLElement>(".tunnel-forward")!;
    const name = row.querySelector<HTMLElement>(".tunnel-forward-name")!;
    const endpoint = row.querySelector<HTMLElement>(".tunnel-forward-endpoint")!;
    expect(name.textContent).toBe("fwd-f1");
    expect(name.title).toBe("fwd-f1");
    expect(endpoint.textContent).toBe("127.0.0.1:5432 → db:5432");
    expect(endpoint.title).toBe("127.0.0.1:5432 → db:5432");
    expect(name.compareDocumentPosition(endpoint)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("marks a forward whose port is in use", async () => {
    const panel = new TunnelsPanel();
    await panel.init();
    document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!.click();
    await flush();
    // A listening event that reports the forward failed to bind (port in use).
    h.statusHandler!({
      tunnelId: "t1",
      status: "listening",
      forwards: [
        {
          forwardId: "f1",
          localAddr: "127.0.0.1",
          localPort: 5432,
          remoteHost: "db",
          remotePort: 5432,
          bound: false,
        },
      ],
    });
    expect(document.querySelector(".tunnel-forward.is-unbound")).not.toBeNull();
  });

  it("auto-starts a flagged device's tunnel on launch", async () => {
    h.devices = [
      { ...sshDevice("dev-1", "NAS", [forward("f1", 5432)]), tunnelAutoStart: true } as Device,
    ];
    const panel = new TunnelsPanel();
    await panel.init();
    await flush();
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1", ["f1"]);
  });

  it("does not auto-start an unflagged device on launch", async () => {
    // The default fixture has tunnelAutoStart: false.
    const panel = new TunnelsPanel();
    await panel.init();
    await flush();
    expect(startTunnel).not.toHaveBeenCalled();
  });

  it("does not auto-start a flagged device that is already running", async () => {
    h.devices = [
      { ...sshDevice("dev-1", "NAS", [forward("f1", 5432)]), tunnelAutoStart: true } as Device,
    ];
    vi.mocked(listTunnels).mockResolvedValueOnce([
      { tunnelId: "existing", deviceId: "dev-1", forwardIds: ["f1"], forwards: [bound("f1")] },
    ]);
    const panel = new TunnelsPanel();
    await panel.init();
    await flush();
    expect(startTunnel).not.toHaveBeenCalled();
  });

  /* ----- remembered run state across launches ---------------------------- */

  const flagged = (): Device =>
    ({ ...sshDevice("dev-1", "NAS", [forward("f1", 5432)]), tunnelAutoStart: true }) as Device;

  function clickAction(): void {
    document.querySelector<HTMLButtonElement>(".tunnel-card-header .btn")!.click();
  }

  it("does not restart a flagged tunnel the user left stopped", async () => {
    h.devices = [flagged()];
    const panel = new TunnelsPanel({ initialState: { "dev-1": false } });
    await panel.init();
    await flush();
    expect(startTunnel).not.toHaveBeenCalled();
  });

  it("restarts an unflagged tunnel the user left running", async () => {
    const panel = new TunnelsPanel({ initialState: { "dev-1": true } });
    await panel.init();
    await flush();
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1", ["f1"]);
  });

  it("remembers a manual stop and asks for a save", async () => {
    h.devices = [flagged()];
    const onPersist = vi.fn();
    const panel = new TunnelsPanel({ onPersist });
    await panel.init();
    await flush();

    clickAction(); // Stop
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
    expect(panel.layoutState()).toEqual({ "dev-1": false });
    expect(onPersist).toHaveBeenCalled();
  });

  it("remembers a manual start", async () => {
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    await flush();

    clickAction(); // Start
    await flush();
    expect(panel.layoutState()).toEqual({ "dev-1": ["f1"] });
  });

  it("an auto-start alone records nothing (the flag stays the default)", async () => {
    h.devices = [flagged()];
    const panel = new TunnelsPanel();
    await panel.init();
    await flush();
    expect(panel.layoutState()).toBeUndefined();
  });

  it("forgets remembered state for devices that are gone", async () => {
    const panel = new TunnelsPanel({ initialState: { "dev-1": false, ghost: true } });
    await panel.init();
    await flush();
    expect(startTunnel).not.toHaveBeenCalled();
    expect(panel.layoutState()).toEqual({ "dev-1": false });
  });

  it("keeps the restored state until the device list has loaded", () => {
    const panel = new TunnelsPanel({ initialState: { "dev-1": false } });
    expect(panel.layoutState()).toEqual({ "dev-1": false });
  });

  /* ----- orphaned tunnels ------------------------------------------------ */

  async function runningPanel(): Promise<TunnelsPanel> {
    const panel = new TunnelsPanel();
    await panel.init();
    await flush();
    document.querySelector<HTMLButtonElement>(".tunnel-card-header .btn")!.click(); // Start
    await flush();
    return panel;
  }

  it("stops a running tunnel whose device was deleted", async () => {
    const panel = await runningPanel();
    panel.setDevices([]);
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
  });

  it("stops a running tunnel whose device lost all its forwards", async () => {
    const panel = await runningPanel();
    panel.setDevices([sshDevice("dev-1", "NAS", [])]);
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
  });

  it("leaves a running tunnel alone when its device still has forwards", async () => {
    const panel = await runningPanel();
    panel.setDevices([sshDevice("dev-1", "Renamed", [forward("f1", 5432)])]);
    await flush();
    expect(stopTunnel).not.toHaveBeenCalled();
  });

  it("stops a tunnel whose device was deleted while it was starting", async () => {
    let resolveStart: (id: string) => void = () => {};
    vi.mocked(startTunnel).mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveStart = resolve)),
    );
    vi.mocked(crypto.randomUUID).mockReturnValueOnce("t9" as ReturnType<typeof crypto.randomUUID>);
    const panel = new TunnelsPanel();
    await panel.init();
    await flush();
    document.querySelector<HTMLButtonElement>(".tunnel-card-header .btn")!.click();
    await flush();

    panel.setDevices([]);
    resolveStart("t9");
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t9");
  });

  /* ----- events racing the start command --------------------------------- */

  it("honors an error that arrives before startTunnel returns", async () => {
    vi.mocked(startTunnel).mockImplementationOnce(async (_deviceId: string, tunnelId: string) => {
      h.statusHandler!({ tunnelId, status: "error", message: "connection refused", forwards: [] });
      return tunnelId;
    });
    const onError = vi.fn();
    const panel = new TunnelsPanel({ onError });
    await panel.init();
    document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!.click();
    await flush();

    expect(onError).toHaveBeenCalled();
    const status = document.querySelector<HTMLElement>(".tunnel-status")!;
    expect(status.classList.contains("is-stopped")).toBe(true);
  });

  it("a Stop clicked while the start is in flight takes effect once it has started", async () => {
    let started: (id: string) => void = () => {};
    vi.mocked(startTunnel).mockImplementationOnce(
      () => new Promise<string>((resolve) => (started = resolve)),
    );
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!.click(); // Start
    await flush();
    document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!.click(); // Stop
    await flush();
    // The backend doesn't know the tunnel yet, so that first stop is a no-op…
    vi.mocked(stopTunnel).mockClear();

    started("t1");
    await flush();

    // …and is re-sent once the tunnel exists.
    expect(stopTunnel).toHaveBeenCalledWith("t1");
    expect(panel.layoutState()).toEqual({ "dev-1": false });
  });

  it("remembers a Start only once it succeeded", async () => {
    let started: (id: string) => void = () => {};
    vi.mocked(startTunnel).mockImplementationOnce(
      () => new Promise<string>((resolve) => (started = resolve)),
    );
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!.click();
    await flush();
    expect(panel.layoutState()).toBeUndefined();

    started("t1");
    await flush();
    expect(panel.layoutState()).toEqual({ "dev-1": ["f1"] });
  });

  it("a Start the backend rejects is remembered as stopped (no retry every launch)", async () => {
    vi.mocked(startTunnel).mockRejectedValueOnce({ code: "Validation", message: "ProxyJump" });
    const panel = new TunnelsPanel({ initialState: { "dev-1": true }, onError: vi.fn() });
    await panel.init(); // launch start from the remembered state is rejected
    await flush();
    expect(panel.layoutState()).toEqual({ "dev-1": false });
  });

  it("a failed device refresh stops nothing and forgets nothing", async () => {
    const panel = new TunnelsPanel({ initialState: { "dev-1": true }, onError: vi.fn() });
    await panel.init(); // starts dev-1
    await flush();
    vi.mocked(listDevices).mockRejectedValueOnce({ code: "Io", message: "disk" });

    await panel.refresh();
    await flush();

    expect(stopTunnel).not.toHaveBeenCalled();
    expect(panel.layoutState()).toEqual({ "dev-1": true });
  });

  it("a failed device load at launch keeps the remembered state", async () => {
    vi.mocked(listDevices).mockRejectedValueOnce({ code: "Io", message: "disk" });
    const panel = new TunnelsPanel({ initialState: { "dev-1": false }, onError: vi.fn() });
    await panel.init();
    expect(panel.layoutState()).toEqual({ "dev-1": false });
  });

  /* ----- per-forward Start/Stop ------------------------------------------ */

  const twoForwards = (): Device =>
    sshDevice("dev-1", "NAS", [forward("f1", 5432), forward("f2", 6543)]);

  function forwardButton(forwardId: string): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(
      `.tunnel-forward[data-forward-id="${forwardId}"] .tunnel-forward-toggle`,
    )!;
  }

  function dot(forwardId: string): HTMLElement {
    return document.querySelector<HTMLElement>(
      `.tunnel-forward[data-forward-id="${forwardId}"] .tunnel-forward-dot`,
    )!;
  }

  function headerButton(): HTMLButtonElement {
    return document.querySelector<HTMLButtonElement>(".tunnel-card-header .btn")!;
  }

  function listening(...forwards: ForwardStatus[]): void {
    h.statusHandler!({ tunnelId: "t1", status: "listening", forwards });
  }

  it("shows a gray dot and a Start button on each stopped forward", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel();
    await panel.init();
    expect(dot("f1").classList.contains("is-stopped")).toBe(true);
    expect(dot("f1").getAttribute("aria-label")).toBe("Stopped");
    expect(forwardButton("f1").getAttribute("aria-label")).toBe("Start");
  });

  it("starts a tunnel carrying only the forward whose Start was clicked", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f2").click();
    await flush();
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1", ["f2"]);
    expect(dot("f2").classList.contains("is-connecting")).toBe(true);
    expect(dot("f1").classList.contains("is-stopped")).toBe(true);
    expect(panel.layoutState()).toEqual({ "dev-1": ["f2"] });
  });

  it("colors each forward's dot from the live bind state", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel();
    await panel.init();
    headerButton().click(); // Start all
    await flush();
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1", ["f1", "f2"]);

    listening(bound("f1"), bound("f2", false));
    expect(dot("f1").classList.contains("is-listening")).toBe(true);
    expect(dot("f2").classList.contains("is-unbound")).toBe(true);
    expect(dot("f2").getAttribute("aria-label")).toBe("port in use");
    expect(forwardButton("f1").getAttribute("aria-label")).toBe("Stop");
  });

  it("binds a forward on the running tunnel instead of opening another", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click();
    await flush();
    listening(bound("f1"));

    forwardButton("f2").click();
    await flush();
    expect(startTunnel).toHaveBeenCalledTimes(1);
    expect(startTunnelForward).toHaveBeenCalledWith("t1", "f2");
    expect(dot("f2").classList.contains("is-connecting")).toBe(true);
    expect(panel.layoutState()).toEqual({ "dev-1": ["f1", "f2"] });
  });

  it("releases one forward and keeps the others running", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    headerButton().click();
    await flush();
    listening(bound("f1"), bound("f2"));

    forwardButton("f1").click();
    await flush();
    expect(stopTunnelForward).toHaveBeenCalledWith("t1", "f1");
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(dot("f1").classList.contains("is-stopped")).toBe(true);
    expect(panel.layoutState()).toEqual({ "dev-1": ["f2"] });
    expect(headerButton().getAttribute("aria-label")).toBe("Stop all");
  });

  it("stopping the last running forward stops the tunnel", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click();
    await flush();
    listening(bound("f1"));

    forwardButton("f1").click();
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
    expect(stopTunnelForward).not.toHaveBeenCalled();
    expect(panel.layoutState()).toEqual({ "dev-1": false });
    expect(headerButton().getAttribute("aria-label")).toBe("Start all");
  });

  it("Stop all stops the tunnel with every forward", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click();
    await flush();
    listening(bound("f1"));

    headerButton().click(); // Stop all
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
    expect(dot("f1").classList.contains("is-stopped")).toBe(true);
    expect(panel.layoutState()).toEqual({ "dev-1": false });
  });

  it("a forward started while the tunnel is still starting is bound once it has", async () => {
    let started: (id: string) => void = () => {};
    vi.mocked(startTunnel).mockImplementationOnce(
      () => new Promise<string>((resolve) => (started = resolve)),
    );
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click();
    await flush();
    forwardButton("f2").click();
    await flush();
    expect(startTunnelForward).not.toHaveBeenCalled();

    started("t1");
    await flush();
    expect(startTunnelForward).toHaveBeenCalledWith("t1", "f2");
    expect(panel.layoutState()).toEqual({ "dev-1": ["f1", "f2"] });
  });

  it("a forward the backend refuses to bind goes back to stopped", async () => {
    vi.mocked(startTunnelForward).mockRejectedValueOnce({ code: "Validation", message: "gone" });
    h.devices = [twoForwards()];
    const onError = vi.fn();
    const panel = new TunnelsPanel({ onError, onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click();
    await flush();
    listening(bound("f1"));

    forwardButton("f2").click();
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(dot("f2").classList.contains("is-stopped")).toBe(true);
    expect(panel.layoutState()).toEqual({ "dev-1": ["f1"] });
  });

  it("releases a running forward that was deleted from its device", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    headerButton().click();
    await flush();
    listening(bound("f1"), bound("f2"));

    panel.setDevices([sshDevice("dev-1", "NAS", [forward("f1", 5432)])]);
    await flush();
    expect(stopTunnelForward).toHaveBeenCalledWith("t1", "f2");
    expect(stopTunnel).not.toHaveBeenCalled();
  });

  it("stops the tunnel when every running forward was deleted", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f2").click();
    await flush();
    listening(bound("f2"));

    panel.setDevices([sshDevice("dev-1", "NAS", [forward("f1", 5432)])]);
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
    expect(dot("f1").classList.contains("is-stopped")).toBe(true);
  });

  it("restores only the forwards the user left running", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ initialState: { "dev-1": ["f2"] } });
    await panel.init();
    await flush();
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1", ["f2"]);
  });

  it("shows an already-running tunnel's forwards as they are", async () => {
    h.devices = [twoForwards()];
    vi.mocked(listTunnels).mockResolvedValueOnce([
      { tunnelId: "existing", deviceId: "dev-1", forwardIds: ["f2"], forwards: [bound("f2")] },
    ]);
    const panel = new TunnelsPanel();
    await panel.init();
    expect(dot("f1").classList.contains("is-stopped")).toBe(true);
    expect(dot("f2").classList.contains("is-listening")).toBe(true);
  });

  it("shows a tunnel adopted while still connecting as connecting, with Stop all", async () => {
    h.devices = [twoForwards()];
    vi.mocked(listTunnels).mockResolvedValueOnce([
      { tunnelId: "existing", deviceId: "dev-1", forwardIds: ["f2"], forwards: [] },
    ]);
    const panel = new TunnelsPanel();
    await panel.init();
    expect(dot("f2").classList.contains("is-connecting")).toBe(true);
    expect(headerButton().getAttribute("aria-label")).toBe("Stop all");
  });

  /* ----- adversarial-review fixes ---------------------------------------- */

  it("stops a tunnel replaced while its start was in flight (Start, Stop, Start)", async () => {
    let firstStarted: (id: string) => void = () => {};
    vi.mocked(startTunnel).mockImplementationOnce(
      () => new Promise<string>((resolve) => (firstStarted = resolve)),
    );
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce("t1" as ReturnType<typeof crypto.randomUUID>)
      .mockReturnValueOnce("t2" as ReturnType<typeof crypto.randomUUID>);
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click(); // Start (t1, in flight)
    await flush();
    forwardButton("f1").click(); // Stop
    await flush();
    forwardButton("f1").click(); // Start again (t2)
    await flush();
    vi.mocked(stopTunnel).mockClear();

    firstStarted("t1");
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
    expect(stopTunnel).not.toHaveBeenCalledWith("t2");
    expect(panel.layoutState()).toEqual({ "dev-1": ["f1"] });
  });

  it("sends a device's forward changes to the backend in click order", async () => {
    let added: () => void = () => {};
    vi.mocked(startTunnelForward).mockImplementationOnce(
      () => new Promise<void>((resolve) => (added = resolve)),
    );
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f2").click();
    await flush();
    listening(bound("f2"));

    forwardButton("f1").click(); // Start f1 (backend call pending)
    await flush();
    forwardButton("f2").click(); // Stop f2 — must not overtake the add
    await flush();
    expect(startTunnelForward).toHaveBeenCalledWith("t1", "f1");
    expect(stopTunnelForward).not.toHaveBeenCalled();

    added();
    await flush();
    expect(stopTunnelForward).toHaveBeenCalledWith("t1", "f2");
    expect(stopTunnel).not.toHaveBeenCalled();
  });

  it("puts the forwards back when Stop all fails", async () => {
    h.devices = [twoForwards()];
    const onError = vi.fn();
    const panel = new TunnelsPanel({ onError, onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click();
    await flush();
    listening(bound("f1"));
    vi.mocked(stopTunnel).mockRejectedValueOnce({ code: "Io", message: "ipc" });

    headerButton().click(); // Stop all
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(dot("f1").classList.contains("is-listening")).toBe(true);
    expect(headerButton().getAttribute("aria-label")).toBe("Stop all");
    expect(panel.layoutState()).toEqual({ "dev-1": ["f1"] });
  });

  it("puts a forward back when its Stop fails", async () => {
    h.devices = [twoForwards()];
    const onError = vi.fn();
    const panel = new TunnelsPanel({ onError, onPersist: vi.fn() });
    await panel.init();
    headerButton().click();
    await flush();
    listening(bound("f1"), bound("f2"));
    vi.mocked(stopTunnelForward).mockRejectedValueOnce({ code: "Io", message: "ipc" });

    forwardButton("f1").click();
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(dot("f1").classList.contains("is-listening")).toBe(true);
  });

  const moved = (): Device => ({ ...twoForwards(), host: "10.0.0.2" }) as Device;

  it("restarts a running tunnel whose connection settings changed", async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce("t1" as ReturnType<typeof crypto.randomUUID>)
      .mockReturnValueOnce("t2" as ReturnType<typeof crypto.randomUUID>);
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f2").click();
    await flush();
    listening(bound("f2"));

    panel.setDevices([moved()]);
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
    expect(dot("f2").classList.contains("is-connecting")).toBe(true);
    expect(startTunnel).toHaveBeenCalledTimes(1); // waits for the old one to let go

    h.statusHandler!({ tunnelId: "t1", status: "disconnected", forwards: [] });
    await flush();
    expect(startTunnel).toHaveBeenLastCalledWith("dev-1", "t2", ["f2"]);
    expect(dot("f2").classList.contains("is-connecting")).toBe(true);
  });

  it("a forward stopped while restarting is left out of the restart", async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce("t1" as ReturnType<typeof crypto.randomUUID>)
      .mockReturnValueOnce("t2" as ReturnType<typeof crypto.randomUUID>);
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    headerButton().click();
    await flush();
    listening(bound("f1"), bound("f2"));

    panel.setDevices([moved()]);
    await flush();
    forwardButton("f1").click(); // Stop f1 during the restart
    await flush();
    expect(stopTunnelForward).not.toHaveBeenCalled();

    h.statusHandler!({ tunnelId: "t1", status: "disconnected", forwards: [] });
    await flush();
    expect(startTunnel).toHaveBeenLastCalledWith("dev-1", "t2", ["f2"]);
  });

  it("does not restart a tunnel for a cosmetic device edit", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click();
    await flush();
    listening(bound("f1"));

    panel.setDevices([{ ...twoForwards(), name: "Renamed", tags: ["db"] } as Device]);
    await flush();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(startTunnelForward).not.toHaveBeenCalled();
  });

  it("re-binds a running forward whose ports were edited", async () => {
    h.devices = [twoForwards()];
    const panel = new TunnelsPanel({ onPersist: vi.fn() });
    await panel.init();
    forwardButton("f1").click();
    await flush();
    listening(bound("f1"));

    panel.setDevices([sshDevice("dev-1", "NAS", [forward("f1", 15432), forward("f2", 6543)])]);
    await flush();
    expect(startTunnelForward).toHaveBeenCalledWith("t1", "f1");
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(dot("f1").classList.contains("is-connecting")).toBe(true);
  });
});
