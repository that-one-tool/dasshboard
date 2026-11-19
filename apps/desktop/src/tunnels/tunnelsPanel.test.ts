/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Device, Forward, ForwardStatus } from "../ipc";
import { FakeTunnelsPort } from "./fakeTunnelsPort.testing";
import { TunnelsPanel, type TunnelsPanelOptions } from "./tunnelsPanel";

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

const twoForwards = (): Device => sshDevice("dev-1", "NAS", [forward("f1", 5432), forward("f2", 6543)]);

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function headerButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(".tunnel-card-header .btn")!;
}

function forwardButton(forwardId: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.tunnel-forward[data-forward-id="${forwardId}"] .tunnel-forward-toggle`)!;
}

function dot(forwardId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.tunnel-forward[data-forward-id="${forwardId}"] .tunnel-forward-dot`)!;
}

function tunnelStatus(): HTMLElement {
  return document.querySelector<HTMLElement>(".tunnel-status")!;
}

describe("TunnelsPanel", () => {
  let port: FakeTunnelsPort;
  let panel: TunnelsPanel;

  beforeEach(() => {
    document.body.innerHTML = '<div class="tunnel-list"></div>';
    port = new FakeTunnelsPort();
    port.devices = [sshDevice("dev-1", "NAS", [forward("f1", 5432)])];
  });

  afterEach(() => panel?.dispose());

  async function launch(options: TunnelsPanelOptions = {}): Promise<TunnelsPanel> {
    panel = new TunnelsPanel(options, port);
    await panel.init();
    await flush();
    return panel;
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    button.click();
    await flush();
  }

  function listening(...forwards: ForwardStatus[]): void {
    port.emit({ tunnelId: port.lastTunnelId(), status: "listening", forwards });
  }

  it("renders a card only for tunnelable devices", async () => {
    port.devices = [sshDevice("dev-1", "NAS", [forward("f1", 5432)]), sshDevice("dev-2", "NoForwards", [])];
    await launch();
    expect(document.querySelectorAll(".tunnel-card")).toHaveLength(1);
    expect(document.querySelector(".tunnel-card-name")!.textContent).toBe("NAS");
  });

  it("renders the card into the .tunnel-list sidebar section with a header", async () => {
    await launch();
    expect(document.querySelector(".tunnel-list .tunnel-manager")).not.toBeNull();
    expect(document.querySelector(".tunnel-list .device-list-header h2")!.textContent).toBe("Tunnels");
  });

  it("works without its sidebar section", async () => {
    document.body.innerHTML = "";
    const onForwardsChange = vi.fn();
    await launch({ onForwardsChange });
    expect(onForwardsChange).toHaveBeenCalled();
  });

  it("starts a tunnel on the Start button", async () => {
    await launch();
    await click(headerButton());
    expect(port.calls).toEqual(["start dev-1 t1 f1"]);
  });

  it("reflects a listening event and stops on the Stop button", async () => {
    await launch();
    await click(headerButton());
    listening(bound("f1"));

    expect(tunnelStatus().classList.contains("is-listening")).toBe(true);
    expect(tunnelStatus().getAttribute("aria-label")).toBe("Listening");
    expect(headerButton().getAttribute("aria-label")).toBe("Stop all");

    await click(headerButton());
    expect(port.calls).toEqual(["start dev-1 t1 f1", "stop t1"]);
    expect(tunnelStatus().classList.contains("is-stopped")).toBe(true);
  });

  it("reports its running-forward count whenever a tunnel changes", async () => {
    const onForwardsChange = vi.fn();
    await launch({ onForwardsChange });
    await click(headerButton());
    onForwardsChange.mockClear();

    listening(bound("f1"));
    expect(onForwardsChange).toHaveBeenCalled();
    expect(panel.listeningForwardCount()).toBe(1);
  });

  it("shows a stopped tunnel as an icon status and icon-only buttons", async () => {
    await launch();
    expect(tunnelStatus().classList.contains("is-stopped")).toBe(true);
    expect(tunnelStatus().getAttribute("aria-label")).toBe("Stopped");
    expect(tunnelStatus().title).toBe("Stopped");
    expect(tunnelStatus().querySelector("svg")).not.toBeNull();

    expect(headerButton().classList.contains("btn-icon")).toBe(true);
    expect(headerButton().getAttribute("aria-label")).toBe("Start all");
    expect(headerButton().title).toBe("Start all");
    expect(headerButton().textContent!.trim()).toBe("");

    const copy = document.querySelector<HTMLButtonElement>(".tunnel-forward .tunnel-copy")!;
    expect(copy.classList.contains("btn-icon")).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Copy the local address:port");
    expect(copy.textContent!.trim()).toBe("");
  });

  it("shows each forward's name above its endpoint", async () => {
    await launch();
    const row = document.querySelector<HTMLElement>(".tunnel-forward")!;
    const name = row.querySelector<HTMLElement>(".tunnel-forward-name")!;
    const endpoint = row.querySelector<HTMLElement>(".tunnel-forward-endpoint")!;
    expect(name.textContent).toBe("fwd-f1");
    expect(name.title).toBe("fwd-f1");
    expect(endpoint.textContent).toBe("127.0.0.1:5432 → db:5432");
    expect(endpoint.title).toBe("127.0.0.1:5432 → db:5432");
    expect(name.compareDocumentPosition(endpoint)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("marks a forward whose port is in use", async () => {
    await launch();
    await click(headerButton());
    listening(bound("f1", false));
    expect(document.querySelector(".tunnel-forward.is-unbound")).not.toBeNull();
  });

  it("says the server refused a remote forward it couldn't start", async () => {
    const remote: Forward = { ...forward("f1", 3000), kind: "remote", remoteHost: "localhost", remotePort: 8080 };
    port.devices = [sshDevice("dev-1", "NAS", [remote])];
    await launch();
    expect(document.querySelector<HTMLButtonElement>(".tunnel-forward .tunnel-copy")!.title).toBe("Copy the server address:port");
    await click(headerButton());
    listening(bound("f1", false));
    expect(dot("f1").getAttribute("aria-label")).toBe("refused by the server");
    expect(document.querySelector(".tunnel-forward-warn")!.textContent).toBe("refused by the server");
  });

  it("copies a forward's endpoint and says so", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onSuccess = vi.fn();
    await launch({ onSuccess });
    await click(document.querySelector<HTMLButtonElement>(".tunnel-forward .tunnel-copy")!);
    expect(writeText).toHaveBeenCalledWith("127.0.0.1:5432");
    expect(onSuccess).toHaveBeenCalledWith("Copied to clipboard");
    vi.unstubAllGlobals();
  });

  it("stays silent when the clipboard is blocked", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("blocked"))) } });
    const onSuccess = vi.fn();
    await launch({ onSuccess });
    await click(document.querySelector<HTMLButtonElement>(".tunnel-forward .tunnel-copy")!);
    expect(onSuccess).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("redraws the cards after a device refresh", async () => {
    await launch();
    port.devices = [];
    await panel.refresh();
    expect(document.querySelector(".tunnel-card")).toBeNull();
    expect(document.querySelector(".tunnels-empty")).not.toBeNull();
  });

  it("rebuilds the card on retranslate", async () => {
    await launch();
    const before = document.querySelector(".tunnel-manager");
    panel.retranslate();
    expect(document.querySelector(".tunnel-manager")).not.toBe(before);
    expect(document.querySelectorAll(".tunnel-card")).toHaveLength(1);
  });

  it("saves the run state the user chose", async () => {
    const onPersist = vi.fn();
    await launch({ onPersist, initialState: { "dev-1": false } });
    expect(panel.layoutState()).toEqual({ "dev-1": false });
    await click(headerButton());
    expect(onPersist).toHaveBeenCalled();
    expect(panel.layoutState()).toEqual({ "dev-1": ["f1"] });
  });

  it("reports a failed start", async () => {
    port.failNext("startTunnel", { code: "Validation", message: "ProxyJump" });
    const onError = vi.fn();
    await launch({ onError });
    await click(headerButton());
    expect(onError).toHaveBeenCalledWith({ code: "Validation", message: "ProxyJump" });
    expect(tunnelStatus().classList.contains("is-stopped")).toBe(true);
  });

  describe("forward rows", () => {
    beforeEach(() => {
      port.devices = [twoForwards()];
    });

    it("shows a gray dot and a Start button on each stopped forward", async () => {
      await launch();
      expect(dot("f1").classList.contains("is-stopped")).toBe(true);
      expect(dot("f1").getAttribute("aria-label")).toBe("Stopped");
      expect(forwardButton("f1").getAttribute("aria-label")).toBe("Start");
    });

    it("starts only the forward whose Start was clicked", async () => {
      await launch();
      await click(forwardButton("f2"));
      expect(port.calls).toEqual(["start dev-1 t1 f2"]);
      expect(dot("f2").classList.contains("is-connecting")).toBe(true);
      expect(dot("f1").classList.contains("is-stopped")).toBe(true);
    });

    it("colors each forward's dot from the live bind state", async () => {
      await launch();
      await click(headerButton());
      listening(bound("f1"), bound("f2", false));
      expect(dot("f1").classList.contains("is-listening")).toBe(true);
      expect(dot("f2").classList.contains("is-unbound")).toBe(true);
      expect(dot("f2").getAttribute("aria-label")).toBe("port in use");
      expect(forwardButton("f1").getAttribute("aria-label")).toBe("Stop");
    });

    it("stops one forward on its Stop button and keeps the others", async () => {
      await launch();
      await click(headerButton());
      listening(bound("f1"), bound("f2"));
      await click(forwardButton("f1"));
      expect(port.calls).toEqual(["start dev-1 t1 f1,f2", "unbind t1 f1"]);
      expect(dot("f1").classList.contains("is-stopped")).toBe(true);
      expect(headerButton().getAttribute("aria-label")).toBe("Stop all");
    });

    it("shows the forward running again when its Stop fails", async () => {
      await launch({ onError: vi.fn() });
      await click(headerButton());
      listening(bound("f1"), bound("f2"));
      port.failNext("stopTunnelForward", { code: "Io", message: "ipc" });
      await click(forwardButton("f1"));
      expect(dot("f1").classList.contains("is-listening")).toBe(true);
    });

    it("shows an already-running tunnel's forwards as they are", async () => {
      port.tunnels = [{ tunnelId: "existing", deviceId: "dev-1", forwardIds: ["f2"], forwards: [bound("f2")] }];
      await launch();
      expect(dot("f1").classList.contains("is-stopped")).toBe(true);
      expect(dot("f2").classList.contains("is-listening")).toBe(true);
    });

    it("shows a tunnel adopted while still connecting as connecting, with Stop all", async () => {
      port.tunnels = [{ tunnelId: "existing", deviceId: "dev-1", forwardIds: ["f2"], forwards: [] }];
      await launch();
      expect(dot("f2").classList.contains("is-connecting")).toBe(true);
      expect(headerButton().getAttribute("aria-label")).toBe("Stop all");
    });
  });
});
