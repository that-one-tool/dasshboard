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
  startTunnel: vi.fn(async () => "t1"),
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
        localAddr: "127.0.0.1",
        localPort: 5432,
        remoteHost: "db",
        remotePort: 6543,
      }),
    ).toBe("127.0.0.1:5432 → db:6543");
  });
});

describe("TunnelsPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="tunnel-list"></div>';
    h.statusHandler = null;
    vi.clearAllMocks();
    h.devices = [sshDevice("dev-1", "NAS", [forward("f1", 5432)])];
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
    expect(startTunnel).toHaveBeenCalledWith("dev-1");
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

    expect(document.querySelector(".tunnel-chip")!.textContent).toBe("Listening");
    const action = document.querySelector<HTMLButtonElement>(".tunnel-card .btn")!;
    expect(action.textContent).toBe("Stop");

    action.click();
    await flush();
    expect(stopTunnel).toHaveBeenCalledWith("t1");
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
    expect(startTunnel).toHaveBeenCalledWith("dev-1");
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
});
