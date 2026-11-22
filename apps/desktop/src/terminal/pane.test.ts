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
import type { RecordingFailedEvent, SessionStatusEvent, TerminalSettings } from "../ipc";

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
    proxyJump: null,
    forwardAgent: false,
    x11Forwarding: "off" as const,
    autoReconnect: false,
    tags: [],
    connectSnippet: null,
  };
  return {
    device,
    sessionId: "sess-1",
    statusHandler: null as ((event: SessionStatusEvent) => void) | null,
    recordingFailedHandler: null as ((event: RecordingFailedEvent) => void) | null,
  };
});

vi.mock("../ipc", () => ({
  logToBackend: vi.fn(),
  warnThrottled: vi.fn(),
  listDevices: vi.fn(async () => [h.device]),
  connect: vi.fn(async () => h.sessionId),
  disconnect: vi.fn(async () => {}),
  writeStdin: vi.fn(async () => {}),
  writeStdinBinary: vi.fn(async () => {}),
  resizePty: vi.fn(async () => {}),
  saveTextFile: vi.fn(async () => {}),
  // No output unless a test scripts some.
  readOutput: vi.fn(() => new Promise(() => {})),
  onSessionStatus: vi.fn(async (handler: (e: SessionStatusEvent) => void) => {
    h.statusHandler = handler;
    return () => {};
  }),
  startRecording: vi.fn(async () => {}),
  stopRecording: vi.fn(async () => {}),
  onRecordingFailed: vi.fn(async (handler: (e: RecordingFailedEvent) => void) => {
    h.recordingFailedHandler = handler;
    return () => {};
  }),
}));

const confirmMock = vi.hoisted(() => vi.fn(async () => false));
vi.mock("../ui/confirm", () => ({ confirm: confirmMock }));

const pickTextSavePathMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "/home/me/out.txt"));
const pickLogSavePathMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "/home/me/rec.log"));
vi.mock("../ui/fileDialog", () => ({
  pickTextSavePath: pickTextSavePathMock,
  pickLogSavePath: pickLogSavePathMock,
}));

const showToastMock = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ showToast: showToastMock }));

const openUrlMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

// The pane picks its session id up front; pin it so status events can target it.
beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    h.sessionId as ReturnType<typeof crypto.randomUUID>,
  );
});

// Imported after the mock is registered so the module graph uses it.
import { TerminalPane, deviceEndpoint, deviceOptionLabel } from "./pane";
import {
  connect,
  disconnect,
  listDevices,
  logToBackend,
  readOutput,
  resizePty,
  saveTextFile,
  startRecording,
  warnThrottled,
  writeStdin,
} from "../ipc";
import type { Device, OutputChunk } from "../ipc";
import { setLocale } from "../i18n";
import { DeviceCatalog } from "../devices/deviceCatalog";
import { ipcDevicesPort } from "../devices/devicesPort";

/** The device list of the pane built last (over the mocked `listDevices`). */
let catalog: DeviceCatalog;

/** A catalog loaded from the mocked `listDevices` as it is now. */
async function loadCatalog(): Promise<DeviceCatalog> {
  catalog = new DeviceCatalog(ipcDevicesPort);
  await catalog.refresh();
  return catalog;
}

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
    proxyJump: null,
    forwardAgent: false,
    x11Forwarding: "off",
    autoReconnect: false,
    tags: [],
    connectSnippet: null,
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
    tags: [],
    connectSnippet: null,
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
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
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

describe("TerminalPane native paste (Cmd+V / Edit → Paste)", () => {
  beforeEach(() => {
    h.statusHandler = null;
    confirmMock.mockClear();
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText: vi.fn(async () => {}) },
    });
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  async function connectedPane(): Promise<{ root: HTMLElement; paste: ReturnType<typeof vi.fn> }> {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    const terminal = (pane as unknown as { terminal: { paste(text: string): void } }).terminal;
    const paste = vi.fn();
    terminal.paste = paste;
    return { root, paste };
  }

  function nativePaste(target: HTMLElement, text: string): Event {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    target.dispatchEvent(event);
    return event;
  }

  it("routes a multi-line paste through the confirm instead of the shell", async () => {
    const { root, paste } = await connectedPane();
    const event = nativePaste(q<HTMLElement>(root, ".xterm-helper-textarea"), "rm -rf /tmp/x\nreboot\n");
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(paste).not.toHaveBeenCalled(); // the mocked confirm declines
  });

  it("reads the clipboard on Cmd+Shift+V on macOS", async () => {
    const ua = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    try {
      const { root } = await connectedPane();
      readText.mockClear();
      q<HTMLElement>(root, ".xterm-helper-textarea").dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyV", key: "V", metaKey: true, shiftKey: true, bubbles: true }),
      );
      await flush();
      expect(readText).toHaveBeenCalledOnce();
    } finally {
      ua.mockRestore();
    }
  });

  // F5: WebView2 also fires a native paste for Ctrl+Shift+V unless the key's
  // default is prevented, and that paste went through a second time.
  it("prevents the paste shortcut's default, so no native paste follows", async () => {
    const { root } = await connectedPane();
    const event = new KeyboardEvent("keydown", {
      code: "KeyV",
      key: "V",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    q<HTMLElement>(root, ".xterm-helper-textarea").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  // WebView2 still fires that native paste now and then despite the
  // preventDefault: the shortcut has already pasted, so it is dropped.
  it("drops a native paste fired by the paste shortcut's own key press", async () => {
    const { root, paste } = await connectedPane();
    const textarea = q<HTMLElement>(root, ".xterm-helper-textarea");
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyV", key: "V", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    const event = nativePaste(textarea, "PASTED");
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(paste).toHaveBeenCalledOnce();
  });

  it("pastes natively again once the shortcut's key is released", async () => {
    const { root, paste } = await connectedPane();
    const textarea = q<HTMLElement>(root, ".xterm-helper-textarea");
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyV", key: "V", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    textarea.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyV", key: "V", bubbles: true }));
    nativePaste(textarea, "uptime");
    await flush();

    expect(paste).toHaveBeenCalledWith("uptime");
  });

  it("pastes a single line straight away", async () => {
    const { root, paste } = await connectedPane();
    nativePaste(q<HTMLElement>(root, ".xterm-helper-textarea"), "uptime");
    await flush();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(paste).toHaveBeenCalledWith("uptime");
  });

  it("pastes without control characters, so ESC can't end bracketed paste", async () => {
    const { root, paste } = await connectedPane();
    nativePaste(q<HTMLElement>(root, ".xterm-helper-textarea"), "ls\x1b[201~id");
    await flush();

    expect(paste).toHaveBeenCalledWith("ls[201~id");
  });
});

// The connection rules (races, reconnect budget) are tested DOM-free in
// `connection/terminalConnection.test.ts`; these check what the pane shows and wires.
describe("TerminalPane connection: overlay, chip and buttons", () => {
  const start = (pane: TerminalPane) =>
    (pane as unknown as { startSession(): Promise<void> }).startSession();
  const terminalOf = (pane: TerminalPane) =>
    (pane as unknown as { terminal: { write(data: unknown): void } | null }).terminal;

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
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
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

  it("reports a failed connect and shows its error", async () => {
    vi.mocked(listDevices).mockResolvedValue([h.device]); // no auto-reconnect
    const onError = vi.fn();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(), onError });
    await pane.init();
    pane.assignDevice(h.device.id);
    vi.mocked(connect).mockRejectedValueOnce({ code: "SshConnect", message: "refused" });

    await start(pane);

    expect(onError).toHaveBeenCalledWith("refused");
    expect(q<HTMLElement>(root, ".overlay-detail").textContent).toBe("refused");
    expect(q<HTMLElement>(root, ".pane-status-label").textContent).toBe("Error");
  });

  it("Cancel leaves the status chip on disconnected, not connecting", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await connectThenDrop(pane);

    q<HTMLButtonElement>(root, ".overlay-cancel").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(q<HTMLElement>(root, ".pane-status").classList.contains("pane-status-disconnected")).toBe(true);
  });

  it("does not reconnect a shell that exited on its own (exit / logout)", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    h.statusHandler?.({ sessionId: h.sessionId, status: "exited" });

    expect(q<HTMLElement>(root, ".overlay-title").textContent).toBe("Session ended");
    expect(q<HTMLElement>(root, ".pane-status-label").textContent).toBe("Ended");
    expect(pane.hasLiveSession()).toBe(false);
    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("does not reconnect a user-initiated disconnect", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
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

  it("deleting the assigned device while reconnecting cancels it (no connect to another device)", async () => {
    // Two auto-reconnect devices exist; the pane is reconnecting toward dev-1.
    vi.mocked(listDevices).mockResolvedValue([
      { ...h.device, autoReconnect: true },
      { ...h.device, id: "dev-2", name: "Other", autoReconnect: true },
    ]);
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await connectThenDrop(pane); // reconnecting toward dev-1
    expect(q<HTMLElement>(root, ".overlay-detail").textContent).toContain("Attempt 1");

    // dev-1 deleted → only dev-2 remains; the device-delete flow refreshes panes.
    vi.mocked(listDevices).mockResolvedValue([
      { ...h.device, id: "dev-2", name: "Other", autoReconnect: true },
    ]);
    await catalog.refresh();
    expect(pane.getDeviceId()).toBeNull();

    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    // Must NOT connect to dev-2 (or anything) — nothing left to reconnect to.
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("a manual Connect during the reconnect wait replaces the pending attempt", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await connectThenDrop(pane); // reconnect scheduled

    vi.mocked(connect).mockClear();
    q<HTMLButtonElement>(root, ".pane-connect").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(10000);
    await flush();

    // Only the manual connect — the backoff timer must not start a second one.
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);
  });

  it("shows the session's output in its terminal", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    const replies: Array<(c: OutputChunk) => void> = [];
    vi.mocked(readOutput).mockImplementation(
      () => new Promise<OutputChunk>((resolve) => replies.push(resolve)),
    );

    await start(pane);
    await flush();
    const writeSpy = vi.spyOn(terminalOf(pane)!, "write");
    replies[0]?.({ start: 0, bytes: new TextEncoder().encode("$ "), end: false });
    await flush();

    expect(vi.mocked(readOutput).mock.calls[0]?.[1]).toBe(0);
    expect(writeSpy).toHaveBeenCalledWith(new TextEncoder().encode("$ "), expect.any(Function));
  });

  it("honors a failure that arrives before connect() returns", async () => {
    vi.mocked(listDevices).mockResolvedValue([h.device]); // no auto-reconnect
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    vi.mocked(connect).mockImplementationOnce(async (sessionId: string) => {
      h.statusHandler?.({ sessionId, status: "error", message: "COM3 not found" });
      return sessionId;
    });

    await start(pane);
    await flush();

    expect(q<HTMLElement>(root, ".overlay-detail").textContent).toBe("COM3 not found");
    expect(pane.hasLiveSession()).toBe(false);
  });

  /** Ids s1, s2, s3… for successive connects, so each session is distinct. */
  function distinctSessionIds(): void {
    let n = 0;
    vi.mocked(crypto.randomUUID).mockImplementation(
      () => `s${++n}` as ReturnType<typeof crypto.randomUUID>,
    );
  }

  async function dropThenReconnectAttempt(pane: TerminalPane): Promise<void> {
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane); // s1
    await flush();
    h.statusHandler?.({ sessionId: "s1", status: "connected" });
    h.statusHandler?.({ sessionId: "s1", status: "disconnected" }); // drop → schedule
    await vi.advanceTimersByTimeAsync(2000); // attempt s2: opened, still handshaking
    await flush();
  }

  it("Retry after Cancel runs only the new session", async () => {
    distinctSessionIds();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await dropThenReconnectAttempt(pane);
    q<HTMLButtonElement>(root, ".overlay-cancel").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();

    q<HTMLButtonElement>(root, ".overlay-retry").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush(); // s3
    // The old attempt's late error must not unseat the new session.
    h.statusHandler?.({ sessionId: "s2", status: "error", message: "late" });
    h.statusHandler?.({ sessionId: "s3", status: "connected" });

    expect(pane.isConnected()).toBe(true);
    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.mocked(connect)).not.toHaveBeenCalled(); // no stray reconnect
  });

});

describe("TerminalPane terminal settings (Phase 5)", () => {
  const start = (pane: TerminalPane) =>
    (pane as unknown as { startSession(): Promise<void> }).startSession();
  const terminalOf = (pane: TerminalPane) =>
    (
      pane as unknown as {
        terminal: { options: { fontSize?: number; scrollback?: number } } | null;
      }
    ).terminal;

  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  it("a terminal created after a settings change uses the current settings", async () => {
    let current: TerminalSettings = {
      fontSize: 14,
      fontFamily: "A",
      theme: "dark",
      scrollback: 1000,
    };
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(), getTerminalSettings: () => current });
    await pane.init();
    pane.assignDevice(h.device.id);

    // Settings change BEFORE this pane opens its terminal.
    current = { fontSize: 22, fontFamily: "B", theme: "light", scrollback: 7000 };
    await start(pane);
    await flush();

    expect(terminalOf(pane)?.options.fontSize).toBe(22);
    expect(terminalOf(pane)?.options.scrollback).toBe(7000);
  });

  it("applyTerminalSettings updates a live terminal", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(),
      getTerminalSettings: () => ({
        fontSize: 14,
        fontFamily: "A",
        theme: "dark",
        scrollback: 1000,
      }),
    });
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    expect(terminalOf(pane)?.options.fontSize).toBe(14);

    pane.applyTerminalSettings({
      fontSize: 30,
      fontFamily: "B",
      theme: "light",
      scrollback: 3000,
    });
    expect(terminalOf(pane)?.options.fontSize).toBe(30);
    expect(terminalOf(pane)?.options.scrollback).toBe(3000);
  });
});

describe("TerminalPane PTY size on connect", () => {
  type Internals = {
    startSession(): Promise<void>;
    terminal: { resize(cols: number, rows: number): void };
    fitAddon: { fit(): void };
  };
  const internals = (pane: TerminalPane) => pane as unknown as Internals;

  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    vi.mocked(resizePty).mockClear();
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  /** Opens a session, then makes the next fit land on a new size — as when the
   * layout settles while the pane is still connecting. */
  async function paneResizedWhileConnecting(): Promise<TerminalPane> {
    const pane = new TerminalPane(q<HTMLElement>(document, "#pane-root"), { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    await internals(pane).startSession();
    await flush();
    const inner = internals(pane);
    inner.fitAddon.fit = () => inner.terminal.resize(132, 43);
    vi.mocked(resizePty).mockClear();
    return pane;
  }

  it("pushes the fitted size to the PTY once connected", async () => {
    await paneResizedWhileConnecting();

    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    expect(resizePty).toHaveBeenCalledWith(h.sessionId, 132, 43);
  });

  it("pushes the size when connected arrives before connect() returns", async () => {
    const pane = new TerminalPane(q<HTMLElement>(document, "#pane-root"), { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    vi.mocked(connect).mockImplementationOnce(async () => {
      h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
      return h.sessionId;
    });

    await internals(pane).startSession();

    expect(resizePty).toHaveBeenCalledWith(h.sessionId, expect.any(Number), expect.any(Number));
  });
});

describe("TerminalPane layout resizes", () => {
  let onResize: (() => void) | null;

  beforeEach(() => {
    onResize = null;
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    document.body.innerHTML = '<div id="pane-root"></div>';
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  async function connectedPane(): Promise<TerminalPane> {
    const pane = new TerminalPane(q<HTMLElement>(document, "#pane-root"), { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    vi.mocked(resizePty).mockClear();
    expect(onResize).not.toBeNull();
    return pane;
  }

  it("pushes a layout change to the PTY", async () => {
    await connectedPane();
    onResize?.();
    expect(resizePty).toHaveBeenCalledWith(h.sessionId, expect.any(Number), expect.any(Number));
  });

  it("holds the PTY size back while throttled", async () => {
    const pane = await connectedPane();
    pane.setResizeThrottled(true);
    onResize?.();
    expect(resizePty).not.toHaveBeenCalled();
  });

  it("stops pushing once the session ended", async () => {
    await connectedPane();
    const callback = onResize;
    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" });
    callback?.();
    expect(resizePty).not.toHaveBeenCalled();
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
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);

    await start(pane);
    await flush();

    expect(terminalOf(pane)?.unicode.activeVersion).toBe("11");
  });
});

describe("TerminalPane broadcast input", () => {
  const start = (pane: TerminalPane) =>
    (pane as unknown as { startSession(): Promise<void> }).startSession();

  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    vi.mocked(writeStdin).mockClear();
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  it("sendInput writes to the PTY only once connected", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);

    // Not connected yet: sendInput is a no-op and the pane reports not-connected.
    expect(pane.isConnected()).toBe(false);
    pane.sendInput("nope");
    expect(vi.mocked(writeStdin)).not.toHaveBeenCalled();

    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    expect(pane.isConnected()).toBe(true);
    pane.sendInput("ls\r");
    await flush();
    expect(vi.mocked(writeStdin)).toHaveBeenCalledWith(h.sessionId, "ls\r");
  });

  // Each write is its own IPC call, which the backend may run concurrently:
  // the next one only goes once the one before it is done.
  it("sends input in order, one write at a time", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    let finishFirst = (): void => {};
    vi.mocked(writeStdin).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );

    pane.sendInput("a");
    pane.sendInput("b");
    await flush();
    expect(vi.mocked(writeStdin).mock.calls.map((c) => c[1])).toEqual(["a"]);

    finishFirst();
    await flush();
    expect(vi.mocked(writeStdin).mock.calls.map((c) => c[1])).toEqual(["a", "b"]);
  });

  it("fires onInput for locally-typed input while connected", async () => {
    const onInput = vi.fn();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(), onInput });
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    // Drive the terminal's onData as a real keystroke would.
    const terminal = (
      pane as unknown as { terminal: { input(data: string): void } | null }
    ).terminal;
    terminal?.input("a");
    await flush();

    expect(onInput).toHaveBeenCalledWith("a");
  });

  it("does not broadcast the terminal's own replies (e.g. a device-attributes answer)", async () => {
    const onInput = vi.fn();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(), onInput });
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    vi.mocked(writeStdin).mockClear();

    const terminal = (
      pane as unknown as { terminal: { input(data: string): void } | null }
    ).terminal;
    terminal?.input("\x1b[?62;22c");
    await flush();

    // Still answered to this pane's own program, just not mirrored.
    expect(vi.mocked(writeStdin)).toHaveBeenCalledWith(h.sessionId, "\x1b[?62;22c");
    expect(onInput).not.toHaveBeenCalled();
  });

  it("sendInput does NOT re-fire onInput (no broadcast echo loop)", async () => {
    // The core safety guarantee: a broadcast injected via sendInput writes to
    // the PTY but must not re-enter onInput, or two panes broadcasting to each
    // other would loop forever.
    const onInput = vi.fn();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(), onInput });
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    pane.sendInput("broadcast-payload");
    await flush();

    expect(vi.mocked(writeStdin)).toHaveBeenCalledWith(
      h.sessionId,
      "broadcast-payload",
    );
    expect(onInput).not.toHaveBeenCalled();
  });
});

describe("TerminalPane device list from the catalog", () => {
  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockClear();
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    vi.mocked(disconnect).mockClear();
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  function optionIds(root: HTMLElement): string[] {
    return [...root.querySelectorAll<HTMLOptionElement>(".pane-device-select option")].map((o) => o.value);
  }

  function notice(root: HTMLElement): HTMLElement {
    return q<HTMLElement>(root, ".pane-body .settings-notice");
  }

  async function connectedPane(): Promise<{ root: HTMLElement; pane: TerminalPane }> {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    return { root, pane };
  }

  async function editDevice(edit: Partial<Device>): Promise<void> {
    vi.mocked(listDevices).mockResolvedValue([{ ...h.device, ...edit } as Device]);
    await catalog.refresh();
  }

  it("shows the catalog's devices without fetching them itself", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();

    expect(optionIds(root)).toContain(h.device.id);
    expect(listDevices).toHaveBeenCalledTimes(1);
  });

  it("adds a device the catalog gains to its dropdown", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();

    vi.mocked(listDevices).mockResolvedValue([h.device, { ...h.device, id: "dev-2", name: "Other" }]);
    await catalog.refresh();

    expect(optionIds(root)).toContain("dev-2");
  });

  it("stops following the catalog once disposed", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.dispose();

    vi.mocked(listDevices).mockResolvedValue([h.device, { ...h.device, id: "dev-2", name: "Other" }]);
    await catalog.refresh();

    expect(optionIds(root)).not.toContain("dev-2");
  });

  it("keeps its session and offers Reconnect when its device's connection settings change", async () => {
    const { root, pane } = await connectedPane();
    expect(notice(root).hidden).toBe(true);

    await editDevice({ host: "10.0.0.9" });

    expect(notice(root).hidden).toBe(false);
    expect(notice(root).textContent).toContain("Settings changed — reconnect to apply");
    expect(disconnect).not.toHaveBeenCalled();
    expect(pane.isConnected()).toBe(true);
  });

  it("shows nothing for a rename", async () => {
    const { root } = await connectedPane();

    await editDevice({ name: "Renamed" });

    expect(notice(root).hidden).toBe(true);
  });

  it("shows nothing while no session is open", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);

    await editDevice({ host: "10.0.0.9" });

    expect(notice(root).hidden).toBe(true);
  });

  /** A pane whose connect waits until the returned function is called. */
  async function connectingPane(): Promise<{ root: HTMLElement; finishConnect: () => void }> {
    let finishConnect = (): void => {};
    vi.mocked(connect).mockImplementationOnce(
      () => new Promise<string>((resolve) => (finishConnect = () => resolve(h.sessionId))),
    );
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    void (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    return { root, finishConnect: () => finishConnect() };
  }

  it("holds a settings edit made while connecting until the session opens", async () => {
    const { root, finishConnect } = await connectingPane();

    await editDevice({ host: "10.0.0.9" });
    expect(notice(root).hidden).toBe(true);

    finishConnect();
    await flush();
    expect(notice(root).hidden).toBe(true);

    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    expect(notice(root).hidden).toBe(false);
  });

  // `connect()` only starts the session: the SSH handshake comes after it.
  it("holds a settings edit made during the handshake until the session is connected", async () => {
    const { root, finishConnect } = await connectingPane();
    finishConnect();
    await flush();

    await editDevice({ host: "10.0.0.9" });
    expect(notice(root).hidden).toBe(true);

    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    expect(notice(root).hidden).toBe(false);
  });

  it("drops a settings edit made while connecting when the connect fails", async () => {
    let failConnect = (): void => {};
    vi.mocked(connect).mockImplementationOnce(
      () => new Promise<string>((_resolve, reject) => (failConnect = () => reject(new Error("refused")))),
    );
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    const attempt = (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    await editDevice({ host: "10.0.0.9" });

    failConnect();
    await attempt;
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    expect(notice(root).hidden).toBe(true);
  });

  it("drops a held edit, and the opening session, when the device is then deleted", async () => {
    const { root, finishConnect } = await connectingPane();
    await editDevice({ host: "10.0.0.9" });
    vi.mocked(listDevices).mockResolvedValue([{ ...h.device, id: "dev-2", name: "Other" }]);
    await catalog.refresh();

    finishConnect();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    expect(disconnect).toHaveBeenCalledWith(h.sessionId);
    expect(notice(root).hidden).toBe(true);
  });

  it("drops the shown notice when the device is then deleted", async () => {
    const { root } = await connectedPane();
    await editDevice({ host: "10.0.0.9" });
    vi.mocked(listDevices).mockResolvedValue([]);
    await catalog.refresh();

    expect(notice(root).hidden).toBe(true);
  });

  it("Reconnect only ever connects the device the notice is about", async () => {
    const { root, pane } = await connectedPane();
    await editDevice({ host: "10.0.0.9" });
    pane.assignDevice("dev-2");
    vi.mocked(connect).mockClear();

    q<HTMLButtonElement>(notice(root), "button").click();
    await flush();

    expect(vi.mocked(connect).mock.calls.map((call) => call[1])).toEqual([h.device.id]);
  });

  it("offers Reconnect when the jump host's connection settings change", async () => {
    const jump = { ...h.device, id: "jump", name: "Jump" };
    vi.mocked(listDevices).mockResolvedValue([jump, { ...h.device, proxyJump: "jump" }]);
    const { root } = await connectedPane();

    vi.mocked(listDevices).mockResolvedValue([{ ...jump, port: 2222 }, { ...h.device, proxyJump: "jump" }]);
    await catalog.refresh();

    expect(notice(root).hidden).toBe(false);
  });

  it("Reconnect opens a new session and clears the notice", async () => {
    const { root } = await connectedPane();
    await editDevice({ host: "10.0.0.9" });
    vi.mocked(connect).mockClear();

    q<HTMLButtonElement>(notice(root), "button").click();
    await flush();

    expect(connect).toHaveBeenCalled();
    expect(notice(root).hidden).toBe(true);
  });

  it("a Disconnect clears the notice", async () => {
    const { root } = await connectedPane();
    await editDevice({ host: "10.0.0.9" });

    q<HTMLButtonElement>(root, ".pane-disconnect").click();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" });

    expect(notice(root).hidden).toBe(true);
  });

  it("relabels the notice in a new language", async () => {
    const { root, pane } = await connectedPane();
    await editDevice({ host: "10.0.0.9" });

    setLocale("fr");
    pane.retranslate();
    setLocale("en");

    expect(q<HTMLButtonElement>(notice(root), "button").textContent).toBe("Reconnecter");
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
  // reference the backend just cleaned up. FAILS if a catalog change doesn't
  // clear `deviceId` when the assigned device leaves the list.
  it("drops a deleted device's id when the catalog loses it, so it can't be re-saved", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    expect(pane.getDeviceId()).toBe(h.device.id);

    // The device is deleted → the next device list no longer contains it.
    vi.mocked(listDevices).mockResolvedValueOnce([]);
    await catalog.refresh();

    expect(pane.getDeviceId()).toBeNull();
  });

  it("drops an assigned id the device list never had", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice("never-saved");

    await catalog.refresh();

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
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
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
    await catalog.refresh();

    expect(pane.getDeviceId()).toBeNull();
    expect(pane.hasLiveSession()).toBe(false);
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith(h.sessionId);

    const chip = q<HTMLElement>(root, ".pane-status");
    expect(chip.className).toContain("pane-status-idle");
    const overlay = q<HTMLElement>(root, ".pane-overlay");
    expect(overlay.classList.contains("dialog-hidden")).toBe(true);
  });
});

describe("TerminalPane status chip", () => {
  beforeEach(() => {
    h.statusHandler = null;
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  afterEach(() => setLocale("en"));

  async function connectedPane(): Promise<{ root: HTMLElement; pane: TerminalPane }> {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    return { root, pane };
  }

  it("starts idle, labelled Idle", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    await new TerminalPane(root, { catalog: await loadCatalog() }).init();

    const chip = q<HTMLElement>(root, ".pane-status");
    expect(chip.classList.contains("pane-status-idle")).toBe(true);
    expect(q<HTMLElement>(chip, ".pane-status-label").textContent).toBe("Idle");
    // The tooltip keeps the state readable when a narrow pane hides the label.
    expect(chip.title).toBe("Idle");
  });

  it("follows the session into Connected, then Disconnected", async () => {
    const { root } = await connectedPane();
    const chip = q<HTMLElement>(root, ".pane-status");
    expect(chip.classList.contains("pane-status-connected")).toBe(true);
    expect(q<HTMLElement>(chip, ".pane-status-label").textContent).toBe("Connected");

    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" });
    expect(chip.classList.contains("pane-status-disconnected")).toBe(true);
    expect(q<HTMLElement>(chip, ".pane-status-label").textContent).toBe("Disconnected");
  });

  it("uses icon buttons for connect/disconnect, labelled for hover and assistive tech", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();

    const connect = q<HTMLButtonElement>(root, ".pane-connect");
    expect(connect.classList.contains("btn-icon")).toBe(true);
    expect(connect.querySelector("svg")).toBeInstanceOf(SVGElement);
    expect(connect.textContent?.trim()).toBe("");
    expect(connect.getAttribute("aria-label")).toBe("Connect");
    expect(connect.title).toBe("Connect");
    const disconnect = q<HTMLButtonElement>(root, ".pane-disconnect");
    expect(disconnect.classList.contains("btn-icon")).toBe(true);
    expect(disconnect.getAttribute("aria-label")).toBe("Disconnect");
  });

  it("keeps the icons and relabels the connect/disconnect buttons on retranslate", async () => {
    const { root, pane } = await connectedPane();

    setLocale("fr");
    pane.retranslate();

    const disconnect = q<HTMLButtonElement>(root, ".pane-disconnect");
    expect(disconnect.querySelector("svg")).toBeInstanceOf(SVGElement);
    expect(disconnect.getAttribute("aria-label")).toBe("Déconnecter");
    expect(disconnect.title).toBe("Déconnecter");
    expect(q<HTMLButtonElement>(root, ".pane-connect").getAttribute("aria-label")).toBe("Connecter");
  });

  it("relabels in the new language on retranslate", async () => {
    const { root, pane } = await connectedPane();

    setLocale("fr");
    pane.retranslate();

    expect(q<HTMLElement>(root, ".pane-status-label").textContent).toBe("Connecté");
  });
});

describe("TerminalPane connection status (side-menu count)", () => {
  beforeEach(() => {
    h.statusHandler = null;
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  async function connectedPane(onStatusChange: () => void): Promise<TerminalPane> {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(), onStatusChange });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    return pane;
  }

  it("reports connected once its status chip says so, and every status change", async () => {
    const onStatusChange = vi.fn();
    const pane = await connectedPane(onStatusChange);

    expect(pane.showsConnected()).toBe(true);
    expect(onStatusChange).toHaveBeenCalled();
    onStatusChange.mockClear();
    h.statusHandler?.({ sessionId: h.sessionId, status: "exited" });

    expect(pane.showsConnected()).toBe(false);
    expect(onStatusChange).toHaveBeenCalled();
  });

  it("reports a status change when disposed, no longer connected", async () => {
    const onStatusChange = vi.fn();
    const pane = await connectedPane(onStatusChange);
    onStatusChange.mockClear();

    pane.dispose();

    expect(pane.showsConnected()).toBe(false);
    expect(onStatusChange).toHaveBeenCalledOnce();
  });
});

describe("TerminalPane device picker and device reloads", () => {
  const start = (pane: TerminalPane) =>
    (pane as unknown as { startSession(): Promise<void> }).startSession();

  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    vi.mocked(connect).mockClear();
    vi.mocked(disconnect).mockClear();
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  it("locks the device picker while a connect is in flight, and unlocks it when that fails", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    const select = q<HTMLSelectElement>(root, ".pane-device-select");
    select.value = h.device.id;
    let failConnect: (error: unknown) => void = () => {};
    vi.mocked(connect).mockImplementationOnce(
      () => new Promise<string>((_resolve, reject) => (failConnect = reject)),
    );

    const connecting = start(pane);
    await flush();
    expect(select.disabled).toBe(true);

    failConnect({ code: "connection", message: "refused" });
    await connecting;
    await flush();
    expect(select.disabled).toBe(false);
  });

  it("keeps its device and live session when reloading the device list fails", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    vi.mocked(listDevices).mockRejectedValueOnce({ code: "ipc", message: "busy" });
    await catalog.refresh();

    expect(vi.mocked(disconnect)).not.toHaveBeenCalled();
    expect(pane.getDeviceId()).toBe(h.device.id);
    expect(pane.isConnected()).toBe(true);
  });
});

describe("TerminalPane device name", () => {
  beforeEach(() => {
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  it("sends through a session sender only while that same session is live", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    const send = pane.makeSessionSender();
    vi.mocked(writeStdin).mockClear();

    send("ls\r");
    await flush();
    expect(writeStdin).toHaveBeenCalledWith(h.sessionId, "ls\r");

    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" });
    vi.mocked(writeStdin).mockClear();
    send("ls\r");
    await flush();
    expect(writeStdin).not.toHaveBeenCalled();

    vi.mocked(crypto.randomUUID).mockReturnValueOnce("sess-2" as ReturnType<typeof crypto.randomUUID>);
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    h.statusHandler?.({ sessionId: "sess-2", status: "connected" });
    send("ls\r");
    await flush();
    expect(writeStdin).not.toHaveBeenCalled();
  });

  it("names its assigned device, and is blank when it has none", async () => {
    const pane = new TerminalPane(q<HTMLElement>(document, "#pane-root"), { catalog: await loadCatalog() });
    await pane.init();
    expect(pane.getDeviceName()).toBe("");
    pane.assignDevice(h.device.id);
    expect(pane.getDeviceName()).toBe(h.device.name);
  });
});

describe("TerminalPane find and save output", () => {
  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    vi.mocked(saveTextFile).mockReset().mockResolvedValue(undefined);
    pickTextSavePathMock.mockReset().mockResolvedValue("/home/me/out.txt");
    showToastMock.mockClear();
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  async function newPane(): Promise<{ root: HTMLElement; pane: TerminalPane }> {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    return { root, pane };
  }

  async function connectPane(pane: TerminalPane): Promise<void> {
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
  }

  it("disables find and save until a terminal exists", async () => {
    const { root, pane } = await newPane();
    expect(q<HTMLButtonElement>(root, ".pane-find").disabled).toBe(true);
    expect(q<HTMLButtonElement>(root, ".pane-save-output").disabled).toBe(true);
    await connectPane(pane);
    expect(q<HTMLButtonElement>(root, ".pane-find").disabled).toBe(false);
    expect(q<HTMLButtonElement>(root, ".pane-save-output").disabled).toBe(false);
  });

  it("opens the find bar from its header button", async () => {
    const { root, pane } = await newPane();
    await connectPane(pane);
    q<HTMLButtonElement>(root, ".pane-find").click();
    expect(q<HTMLElement>(root, ".pane-search").hidden).toBe(false);
  });

  it("keeps find and save usable once the session has ended", async () => {
    const { root, pane } = await newPane();
    await connectPane(pane);
    h.statusHandler?.({ sessionId: h.sessionId, status: "exited" });
    expect(q<HTMLButtonElement>(root, ".pane-find").disabled).toBe(false);
    expect(q<HTMLButtonElement>(root, ".pane-save-output").disabled).toBe(false);
  });

  it("saves the output to the picked file, named after the device", async () => {
    const { root, pane } = await newPane();
    await connectPane(pane);
    q<HTMLButtonElement>(root, ".pane-save-output").click();
    await flush();
    expect(pickTextSavePathMock).toHaveBeenCalledWith(expect.stringMatching(/^NAS-.*\.txt$/));
    expect(saveTextFile).toHaveBeenCalledWith("/home/me/out.txt", expect.any(String));
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining("/home/me/out.txt"), "success");
  });

  it("writes nothing when the save dialog is cancelled", async () => {
    pickTextSavePathMock.mockResolvedValue(null);
    const { root, pane } = await newPane();
    await connectPane(pane);
    q<HTMLButtonElement>(root, ".pane-save-output").click();
    await flush();
    expect(saveTextFile).not.toHaveBeenCalled();
  });

  it("reports a failed save", async () => {
    vi.mocked(saveTextFile).mockRejectedValue({ code: "Io", message: "disk full" });
    const onError = vi.fn();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(), onError });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await connectPane(pane);
    q<HTMLButtonElement>(root, ".pane-save-output").click();
    await flush();
    expect(onError).toHaveBeenCalledWith("disk full");
  });
});

describe("TerminalPane output recording", () => {
  beforeEach(() => {
    h.statusHandler = null;
    h.recordingFailedHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    vi.mocked(connect).mockClear();
    vi.mocked(startRecording).mockClear();
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  const start = (pane: TerminalPane) =>
    (pane as unknown as { startSession(): Promise<void> }).startSession();
  const recordButton = (root: HTMLElement) => q<HTMLButtonElement>(root, ".pane-record");

  async function connectedPane(onError?: (message: string) => void): Promise<{ root: HTMLElement; pane: TerminalPane }> {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog(), onError });
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    return { root, pane };
  }

  async function record(root: HTMLElement): Promise<void> {
    recordButton(root).click();
    await flush();
  }

  it("can record once a session is open", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    expect(recordButton(root).disabled).toBe(true);
    pane.assignDevice(h.device.id);
    await start(pane);
    expect(recordButton(root).disabled).toBe(false);
  });

  it("records the open session into the picked file", async () => {
    const { root } = await connectedPane();
    await record(root);
    expect(startRecording).toHaveBeenCalledWith(h.sessionId, "/home/me/rec.log");
  });

  it("a new session of the pane keeps recording into the same file", async () => {
    const { root, pane } = await connectedPane();
    await record(root);
    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" });
    vi.mocked(connect).mockClear();
    await start(pane);
    expect(connect).toHaveBeenCalledWith(h.sessionId, h.device.id, expect.any(Number), expect.any(Number), "/home/me/rec.log");
  });

  it("a session opened without a recording records nothing", async () => {
    await connectedPane();
    expect(connect).toHaveBeenCalledWith(h.sessionId, h.device.id, expect.any(Number), expect.any(Number), undefined);
  });

  it("reports a recording that failed in its session", async () => {
    const onError = vi.fn();
    const { root } = await connectedPane(onError);
    await record(root);
    h.recordingFailedHandler?.({ sessionId: h.sessionId, message: "disk full" });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(recordButton(root).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("TerminalPane terminal keys, links and copy-on-select", () => {
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    h.statusHandler = null;
    writeText.mockClear();
    openUrlMock.mockClear();
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText },
    });
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  type Internals = {
    terminal: import("@xterm/xterm").Terminal;
    startSession(): Promise<void>;
  };

  async function connectedPane(): Promise<{ root: HTMLElement; pane: TerminalPane; terminal: Internals["terminal"] }> {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await (pane as unknown as Internals).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    const terminal = (pane as unknown as Internals).terminal;
    await new Promise<void>((resolve) => terminal.write("hello world", resolve));
    return { root, pane, terminal };
  }

  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("opens the find bar on Ctrl+Shift+F typed in the terminal", async () => {
    const { root } = await connectedPane();
    const key = new KeyboardEvent("keydown", {
      code: "KeyF",
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    q<HTMLElement>(root, ".xterm-helper-textarea").dispatchEvent(key);
    expect(q<HTMLElement>(root, ".pane-search").hidden).toBe(false);
  });

  it("opens OSC 8 links through the same Ctrl+click rule", async () => {
    const { terminal } = await connectedPane();
    const handler = terminal.options.linkHandler;
    const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } };
    handler?.activate(new MouseEvent("click"), "https://example.com", range);
    handler?.activate(new MouseEvent("click", { ctrlKey: true }), "https://example.com", range);
    expect(openUrlMock).toHaveBeenCalledTimes(1);
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
  });

  it("copies a mouse selection once the button is released", async () => {
    const { root, terminal } = await connectedPane();
    q<HTMLElement>(root, ".pane-terminal").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    terminal.select(0, 0, 5);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await nextTask();
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("never copies a selection the search makes", async () => {
    const { root, terminal } = await connectedPane();
    q<HTMLButtonElement>(root, ".pane-find").click();
    const input = q<HTMLInputElement>(root, ".pane-search-input");
    input.value = "world";
    input.dispatchEvent(new Event("input"));
    terminal.select(6, 0, 5); // what the search addon does for a match
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await nextTask();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("stops listening for mouse releases once disposed", async () => {
    const { root, pane, terminal } = await connectedPane();
    q<HTMLElement>(root, ".pane-terminal").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    terminal.select(0, 0, 5);
    pane.dispose();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await nextTask();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("TerminalPane input that stops getting through", () => {
  beforeEach(() => {
    h.statusHandler = null;
    vi.mocked(listDevices).mockResolvedValue([h.device]);
    vi.mocked(writeStdin).mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = '<div id="pane-root"></div>';
  });

  afterEach(() => vi.useRealTimers());

  async function connectedPane(): Promise<{ chip: HTMLElement; pane: TerminalPane }> {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root, { catalog: await loadCatalog() });
    await pane.init();
    pane.assignDevice(h.device.id);
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    return { chip: q<HTMLElement>(root, ".pane-status"), pane };
  }

  const sent = (): unknown[] => vi.mocked(writeStdin).mock.calls.map((call) => call[1]);
  const label = (chip: HTMLElement): string | null => q<HTMLElement>(chip, ".pane-status-label").textContent;

  it("shows Not responding while a send hangs, then delivers the keys typed meanwhile, in order", async () => {
    const { chip, pane } = await connectedPane();
    vi.useFakeTimers();
    let finish = (): void => {};
    vi.mocked(writeStdin).mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));

    pane.sendInput("a");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chip.classList.contains("pane-status-not-responding")).toBe(true);
    expect(label(chip)).toBe("Not responding");
    expect(chip.title).not.toMatch(/[Rr]econnect/);
    pane.sendInput("b");

    finish();
    await vi.advanceTimersByTimeAsync(0);
    pane.sendInput("c");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toEqual(["a", "b", "c"]);
    expect(label(chip)).toBe("Connected");
  });

  it("asks to reconnect after a send failed, and sends no later key", async () => {
    const { chip, pane } = await connectedPane();
    vi.mocked(writeStdin).mockRejectedValueOnce(new Error("ipc failed"));

    pane.sendInput("a");
    await flush();
    pane.sendInput("b");
    await flush();

    expect(sent()).toEqual(["a"]);
    expect(chip.classList.contains("pane-status-input-lost")).toBe(true);
    expect(label(chip)).toBe("Not responding: reconnect");
    expect(chip.title).toMatch(/[Rr]econnect/);
  });

  it("asks to reconnect when a send stays unanswered for 30 s", async () => {
    const { chip, pane } = await connectedPane();
    vi.useFakeTimers();
    vi.mocked(writeStdin).mockImplementationOnce(() => new Promise<void>(() => {}));

    pane.sendInput("a");
    pane.sendInput("b");
    await vi.advanceTimersByTimeAsync(30_000);
    pane.sendInput("c");
    await vi.advanceTimersByTimeAsync(0);

    expect(sent()).toEqual(["a"]);
    expect(label(chip)).toBe("Not responding: reconnect");
  });

  it("puts an input stall in the diagnostic log, named by device", async () => {
    const { pane } = await connectedPane();
    vi.useFakeTimers();
    vi.mocked(writeStdin).mockImplementationOnce(() => new Promise<void>(() => {}));

    pane.sendInput("a");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(warnThrottled).toHaveBeenCalledWith(
      "input stall NAS",
      expect.stringMatching(/^shell NAS: input not responding/),
    );
  });

  it("puts lost input in the diagnostic log, named by device", async () => {
    const { pane } = await connectedPane();
    vi.mocked(writeStdin).mockRejectedValueOnce(new Error("ipc failed"));

    pane.sendInput("a");
    await flush();

    expect(logToBackend).toHaveBeenCalledWith("warn", "shell NAS: input stopped: reconnect");
  });

  it("shows the session's own status once it ends", async () => {
    const { chip, pane } = await connectedPane();
    vi.mocked(writeStdin).mockRejectedValueOnce(new Error("ipc failed"));
    pane.sendInput("a");
    await flush();

    h.statusHandler?.({ sessionId: h.sessionId, status: "disconnected" });

    expect(label(chip)).toBe("Disconnected");
  });

  it("starts a new session with input getting through", async () => {
    const { chip, pane } = await connectedPane();
    vi.mocked(writeStdin).mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    pane.sendInput("a");
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    expect(label(chip)).toBe("Not responding: reconnect");

    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    expect(label(chip)).not.toMatch(/Not responding/);
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    pane.sendInput("b");
    await flush();

    expect(sent()).toEqual(["a", "b"]);
    expect(label(chip)).toBe("Connected");
  });

});
