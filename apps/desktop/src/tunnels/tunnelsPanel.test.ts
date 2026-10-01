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
} from "./tunnelsPanel";
import { listDevices, listTunnels, startTunnel, stopTunnel } from "../ipc";

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
  for (let i = 0; i < 5; i++) await Promise.resolve();
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
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1");
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
    expect(action.getAttribute("aria-label")).toBe("Stop");

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
    expect(start.getAttribute("aria-label")).toBe("Start");
    expect(start.title).toBe("Start");
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
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1");
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
      { tunnelId: "existing", deviceId: "dev-1" },
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
    expect(startTunnel).toHaveBeenCalledWith("dev-1", "t1");
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
    expect(panel.layoutState()).toEqual({ "dev-1": true });
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
    expect(panel.layoutState()).toEqual({ "dev-1": true });
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
});
