/**
 * @vitest-environment happy-dom
 *
 * DOM-lifecycle regression test for `TerminalPane`.
 *
 * Guards the Phase 2 Should-fix finding: the right-click-paste `contextmenu`
 * listener used to be attached inside `startSession()`, directly on the
 * persistent `.pane-terminal` node. Because that node survives reconnects
 * (only the xterm.js content inside it is torn down), every Retry/reconnect
 * added another listener without removing the previous one, so a single
 * right-click pasted the clipboard N times after N connects.
 *
 * This test drives two `startSession()` cycles (one reconnect) and asserts that
 * a single `contextmenu` event triggers exactly ONE clipboard read. Before the
 * fix it fired twice.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionStatusEvent, TerminalSettings } from "../ipc";

const h = vi.hoisted(() => {
  const device = {
    id: "dev-1",
    name: "NAS",
    kind: "ssh" as const,
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    auth: { method: "password" as const },
    forwards: [],
    tunnelAutoStart: false,
    autoReconnect: false,
  };
  return {
    device,
    sessionId: "sess-1",
    statusHandler: null as ((event: SessionStatusEvent) => void) | null,
  };
});

vi.mock("../ipc", () => ({
  listDevices: vi.fn(async () => [h.device]),
  connect: vi.fn(async () => h.sessionId),
  disconnect: vi.fn(async () => {}),
  writeStdin: vi.fn(async () => {}),
  resizePty: vi.fn(async () => {}),
  newDataChannel: vi.fn(() => ({ onmessage: null })),
  onSessionStatus: vi.fn(async (handler: (e: SessionStatusEvent) => void) => {
    h.statusHandler = handler;
    return () => {};
  }),
}));

// Imported after the mock is registered so the module graph uses it.
import { TerminalPane, deviceEndpoint, deviceOptionLabel } from "./pane";
import { connect, disconnect, listDevices } from "../ipc";
import type { Device } from "../ipc";

const readText = vi.fn(async () => "PASTED");

function q<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}

/** Let queued microtasks (the awaited connect + paste chains) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("device dropdown label + tooltip", () => {
  const ssh: Device = {
    id: "s1",
    name: "NAS",
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    auth: { method: "password" },
    forwards: [],
    tunnelAutoStart: false,
    autoReconnect: false,
  };

  const serial: Device = {
    id: "s2",
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

  it("shows host:port for an SSH device", () => {
    expect(deviceEndpoint(ssh)).toBe("10.0.0.1:22");
    expect(deviceOptionLabel(ssh)).toBe("NAS (10.0.0.1:22)");
  });

  it("shows portName @ baudRate for a serial device (never host:port)", () => {
    expect(deviceEndpoint(serial)).toBe("COM3 @ 115200");
    expect(deviceOptionLabel(serial)).toBe("Arduino (COM3 @ 115200)");
  });
});

describe("TerminalPane right-click paste listener", () => {
  beforeEach(() => {
    readText.mockClear();
    h.statusHandler = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText: vi.fn(async () => {}) },
    });
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  it("fires exactly one paste per right-click after a reconnect", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();

    // Pick the device (happy-dom doesn't auto-select the first <option>).
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;

    // `startSession` is private; drive it directly and await each cycle.
    const start = () =>
      (pane as unknown as { startSession(): Promise<void> }).startSession();

    // First connect.
    await start();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    // Reconnect (as a Retry would): a second `startSession` on the same pane.
    await start();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    // One right-click on the persistent terminal container.
    const terminalEl = q<HTMLElement>(root, ".pane-terminal");
    terminalEl.dispatchEvent(new Event("contextmenu", { bubbles: true }));
    await flush();

    expect(readText).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalPane.startSession re-entrancy guard", () => {
  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    vi.mocked(connect).mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText: vi.fn(async () => {}) },
    });
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  // Guards F1: a double-click on Connect used to re-enter startSession() while
  // the first call was suspended at `await connect(...)`, disposing the
  // in-flight terminal, cross-wiring the channel's onmessage, and orphaning a
  // second backend session. FAILS (connect called twice) without the
  // `connecting` guard.
  it("ignores a second startSession() call while the first is still awaiting connect()", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;

    let resolveConnect: (id: string) => void = () => {};
    vi.mocked(connect).mockImplementationOnce(
      () =>
        new Promise<string>((res) => {
          resolveConnect = res;
        }),
    );

    const start = () =>
      (pane as unknown as { startSession(): Promise<void> }).startSession();

    // Call A starts and suspends at `await connect(...)`; call B fires while A
    // is still in flight (the synchronous portion of A — including tearing
    // down/creating the terminal — has already run by the time B is invoked).
    const terminalBefore = (pane as unknown as { terminal: unknown }).terminal;
    const pA = start();
    const pB = start();

    resolveConnect(h.sessionId);
    await Promise.all([pA, pB]);
    await flush();

    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);
    // The terminal created by call A is still the live one — B did not tear it
    // down and replace it with a second terminal.
    const terminalAfter = (pane as unknown as { terminal: unknown }).terminal;
    expect(terminalAfter).not.toBe(terminalBefore);
    expect(pane.hasLiveSession()).toBe(true);
  });
});

describe("TerminalPane.dispose", () => {
  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(disconnect).mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText: vi.fn(async () => {}) },
    });
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  // Guards the Phase 3 behavior that `dispose()` closes any live backend session
  // (SPEC §7). FAILS if the `disconnect(sessionId)` call is removed from
  // `TerminalPane.dispose()` — nothing else in this flow calls `disconnect`.
  it("disconnects the live backend session on dispose", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;

    await (
      pane as unknown as { startSession(): Promise<void> }
    ).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    expect(pane.hasLiveSession()).toBe(true);

    pane.dispose();

    expect(vi.mocked(disconnect)).toHaveBeenCalledWith(h.sessionId);
    expect(pane.hasLiveSession()).toBe(false);
  });
});

describe("TerminalPane auto-reconnect (Phase 5)", () => {
  const start = (pane: TerminalPane) =>
    (pane as unknown as { startSession(): Promise<void> }).startSession();

  beforeEach(() => {
    vi.useFakeTimers();
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([{ ...h.device, autoReconnect: true }]);
    vi.mocked(connect).mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn(async () => ""), writeText: vi.fn(async () => {}) },
    });
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connectThenDrop(pane: TerminalPane): Promise<void> {
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    // Unexpected drop (no user disconnect): should trigger a reconnect schedule.
    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" });
  }

  it("schedules a backoff reconnect on an unexpected drop and retries when it fires", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await connectThenDrop(pane);

    const detail = q<HTMLElement>(root, ".overlay-detail");
    const cancel = q<HTMLButtonElement>(root, ".overlay-cancel");
    expect(detail.textContent).toContain("Attempt 1 of 5");
    expect(cancel.hidden).toBe(false);

    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(2000); // first backoff delay
    await flush();
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1); // reconnect attempt fired
  });

  it("Cancel stops a pending reconnect (no further attempts)", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await connectThenDrop(pane);

    q<HTMLButtonElement>(root, ".overlay-cancel").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    await flush();
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("does not reconnect a user-initiated disconnect", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    // User clicks Disconnect → the following drop is expected, not reconnected.
    q<HTMLButtonElement>(root, ".pane-disconnect").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" });

    const detail = q<HTMLElement>(root, ".overlay-detail");
    expect(detail.textContent ?? "").not.toContain("Attempt");
    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("dispose() cancels a pending reconnect (no attempt after teardown)", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await connectThenDrop(pane); // reconnect scheduled

    pane.dispose();
    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("deleting the assigned device while reconnecting cancels it (no connect to another device)", async () => {
    // Two auto-reconnect devices exist; the pane is reconnecting toward dev-1.
    vi.mocked(listDevices).mockResolvedValue([
      { ...h.device, autoReconnect: true },
      { ...h.device, id: "dev-2", name: "Other", autoReconnect: true },
    ]);
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await connectThenDrop(pane); // reconnecting toward dev-1
    expect(q<HTMLElement>(root, ".overlay-detail").textContent).toContain("Attempt 1");

    // dev-1 deleted → only dev-2 remains; the device-delete flow refreshes panes.
    vi.mocked(listDevices).mockResolvedValue([
      { ...h.device, id: "dev-2", name: "Other", autoReconnect: true },
    ]);
    await pane.refreshDevices();
    expect(pane.getDeviceId()).toBeNull();

    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    // Must NOT connect to dev-2 (or anything) — nothing left to reconnect to.
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("Cancel during an in-flight reconnect attempt does not resume auto-reconnect", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);

    // Initial connect succeeds; the reconnect attempt hangs until we reject it.
    let rejectAttempt: (reason: unknown) => void = () => {};
    vi.mocked(connect)
      .mockImplementationOnce(async () => h.sessionId)
      .mockImplementationOnce(
        () =>
          new Promise<string>((_res, rej) => {
            rejectAttempt = rej;
          }),
      );

    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" }); // drop → schedule

    await vi.advanceTimersByTimeAsync(2000); // backoff fires → reconnect connect() in flight
    await flush();

    // Cancel WHILE the attempt is in flight.
    q<HTMLButtonElement>(root, ".overlay-cancel").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    // The in-flight attempt now fails.
    rejectAttempt({ code: "SshConnect", message: "boom" });
    await flush();

    // Must NOT have re-entered auto-reconnect.
    expect(q<HTMLElement>(root, ".overlay-detail").textContent ?? "").not.toContain(
      "Attempt",
    );
    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });
});

describe("TerminalPane terminal settings (Phase 5)", () => {
  const start = (pane: TerminalPane) =>
    (pane as unknown as { startSession(): Promise<void> }).startSession();
  const terminalOf = (pane: TerminalPane) =>
    (pane as unknown as { terminal: { options: { fontSize?: number } } | null }).terminal;

  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  it("a terminal created after a settings change uses the current settings", async () => {
    let current: TerminalSettings = { fontSize: 14, fontFamily: "A", theme: "dark" };
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { getTerminalSettings: () => current });
    await pane.init();
    pane.assignDevice(h.device.id);

    // Settings change BEFORE this pane opens its terminal.
    current = { fontSize: 22, fontFamily: "B", theme: "light" };
    await start(pane);
    await flush();

    expect(terminalOf(pane)?.options.fontSize).toBe(22);
  });

  it("applyTerminalSettings updates a live terminal", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, {
      getTerminalSettings: () => ({ fontSize: 14, fontFamily: "A", theme: "dark" }),
    });
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    expect(terminalOf(pane)?.options.fontSize).toBe(14);

    pane.applyTerminalSettings({ fontSize: 30, fontFamily: "B", theme: "light" });
    expect(terminalOf(pane)?.options.fontSize).toBe(30);
  });
});

describe("TerminalPane wide-character support", () => {
  const start = (pane: TerminalPane) =>
    (pane as unknown as { startSession(): Promise<void> }).startSession();
  const terminalOf = (pane: TerminalPane) =>
    (pane as unknown as { terminal: { unicode: { activeVersion: string } } | null })
      .terminal;

  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  // A session terminal must activate the Unicode 11 width table so CJK, emoji,
  // and combining marks measure at the correct cell width (default is the
  // Unicode 6 table). `activeVersion` can only be set to "11" once the
  // Unicode11Addon has registered that version, so this asserts both that the
  // addon is loaded and that it is activated. FAILS (default version) if the
  // addon isn't loaded/activated in createSessionTerminal().
  it("activates the Unicode 11 width table on a new session terminal", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);

    await start(pane);
    await flush();

    expect(terminalOf(pane)?.unicode.activeVersion).toBe("11");
  });
});

describe("TerminalPane referential cleanup (Phase 4)", () => {
  beforeEach(() => {
    vi.mocked(listDevices).mockClear();
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  // Guards the Phase 4 Blocking finding: a deleted device's id must not survive
  // in the pane's saved-state, else the next Save re-persists a dangling
  // reference the backend just cleaned up. FAILS if `refreshDevices()` doesn't
  // clear `deviceId` when the assigned device leaves the list.
  it("drops a deleted device's id on refreshDevices so it can't be re-saved", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);
    expect(pane.getDeviceId()).toBe(h.device.id);

    // The device is deleted → the next device list no longer contains it.
    vi.mocked(listDevices).mockResolvedValueOnce([]);
    await pane.refreshDevices();

    expect(pane.getDeviceId()).toBeNull();
  });

  // Guards F2: deleting the device behind an *actively connected* pane used to
  // only call hideOverlay() (forcing an idle dot) while leaving `connected`/
  // `sessionId` set — the pane then lied about being idle while a real backend
  // SSH session was still open. FAILS if the live session isn't force-torn-down
  // (hasLiveSession() stays true, or `disconnect` is never called) when its
  // device disappears mid-session.
  it("force-disconnects a live session when its device is deleted, and reflects idle honestly", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;

    await (
      pane as unknown as { startSession(): Promise<void> }
    ).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    expect(pane.hasLiveSession()).toBe(true);

    vi.mocked(disconnect).mockClear();
    vi.mocked(listDevices).mockResolvedValueOnce([]);
    await pane.refreshDevices();

    expect(pane.getDeviceId()).toBeNull();
    expect(pane.hasLiveSession()).toBe(false);
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith(h.sessionId);

    const dot = q<HTMLElement>(root, ".pane-status-dot");
    expect(dot.className).toContain("pane-status-idle");
    const overlay = q<HTMLElement>(root, ".pane-overlay");
    expect(overlay.classList.contains("dialog-hidden")).toBe(true);
  });
});
