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
    proxyJump: null,
    forwardAgent: false,
    autoReconnect: false,
    tags: [],
    connectSnippet: null,
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
  writeStdinBinary: vi.fn(async () => {}),
  resizePty: vi.fn(async () => {}),
  saveTextFile: vi.fn(async () => {}),
  // No output unless a test scripts some.
  readOutput: vi.fn(() => new Promise(() => {})),
  onSessionStatus: vi.fn(async (handler: (e: SessionStatusEvent) => void) => {
    h.statusHandler = handler;
    return () => {};
  }),
}));

const confirmMock = vi.hoisted(() => vi.fn(async () => false));
vi.mock("../ui/confirm", () => ({ confirm: confirmMock }));

const pickTextSavePathMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "/home/me/out.txt"));
vi.mock("../ui/fileDialog", () => ({ pickTextSavePath: pickTextSavePathMock }));

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
  readOutput,
  resizePty,
  saveTextFile,
  writeStdin,
} from "../ipc";
import type { Device, ErrorCode, OutputChunk } from "../ipc";
import { setLocale } from "../i18n";

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
    const pane = new TerminalPane(root);
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

  async function failFirstConnect(pane: TerminalPane, code: ErrorCode): Promise<void> {
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "error", message: "it failed", code });
  }

  it("does not reconnect a wrong password or a rejected host key (lockout, re-prompts)", async () => {
    for (const code of ["SshAuth", "HostKeyRejected"] as const) {
      document.body.innerHTML = '<div id="pane-root"></div>';
      const root = q<HTMLElement>(document, "#pane-root");
      await failFirstConnect(new TerminalPane(root), code);

      expect(q<HTMLElement>(root, ".overlay-detail").textContent).toContain("it failed");
      vi.mocked(connect).mockClear();
      await vi.advanceTimersByTimeAsync(60000);
      expect(vi.mocked(connect), code).not.toHaveBeenCalled();
    }
  });

  it("retries a first connect that couldn't reach the server (e.g. down at launch)", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    await failFirstConnect(new TerminalPane(root), "SshConnect");

    expect(q<HTMLElement>(root, ".overlay-detail").textContent).toContain("Attempt 1 of 5");
  });

  it("retries a keychain failure once, then stops", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    await failFirstConnect(new TerminalPane(root), "Keyring");
    expect(q<HTMLElement>(root, ".overlay-detail").textContent).toContain("Attempt 1 of 5");

    await vi.advanceTimersByTimeAsync(2000); // the one retry fires
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "error", message: "locked", code: "Keyring" });

    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("keeps reconnecting when a reconnect attempt can't reach the server", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await connectThenDrop(pane);
    await vi.advanceTimersByTimeAsync(2000); // attempt 1 fires
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "error", message: "refused", code: "SshConnect" });

    expect(q<HTMLElement>(root, ".overlay-detail").textContent).toContain("Attempt 2 of 5");
  });

  it("stops reconnecting when an attempt is refused by the server's auth", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await connectThenDrop(pane);
    await vi.advanceTimersByTimeAsync(2000); // attempt 1 fires
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "error", message: "auth failed", code: "SshAuth" });

    vi.mocked(connect).mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
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

  it("Cancel leaves the status chip on disconnected, not connecting", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await connectThenDrop(pane);

    q<HTMLButtonElement>(root, ".overlay-cancel").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(q<HTMLElement>(root, ".pane-status").classList.contains("pane-status-disconnected")).toBe(true);
  });

  it("does not reconnect a shell that exited on its own (exit / logout)", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
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

  it("a manual Connect during the reconnect wait replaces the pending attempt", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
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
    const pane = new TerminalPane(root);
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

  it("output from a replaced session never reaches the new terminal", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);
    const replies: Array<(c: OutputChunk) => void> = [];
    vi.mocked(readOutput).mockImplementation(
      () => new Promise<OutputChunk>((resolve) => replies.push(resolve)),
    );

    await start(pane);
    await flush();
    const first = terminalOf(pane);
    await start(pane); // a fresh session (e.g. Retry) — new terminal
    await flush();
    const second = terminalOf(pane);
    const writeSpy = vi.spyOn(second!, "write");

    replies[0]?.({ start: 0, bytes: new TextEncoder().encode("stale"), end: false });
    await flush();
    expect(first).not.toBe(second);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("honors a failure that arrives before connect() returns", async () => {
    vi.mocked(listDevices).mockResolvedValue([h.device]); // no auto-reconnect
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
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

  it("honors a connected status that arrives before connect() returns", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);
    vi.mocked(connect).mockImplementationOnce(async (sessionId: string) => {
      h.statusHandler?.({ sessionId, status: "connected" });
      return sessionId;
    });

    await start(pane);
    await flush();

    expect(pane.isConnected()).toBe(true);
  });

  it("counts a connect in flight as a live session", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);
    vi.mocked(connect).mockImplementationOnce(() => new Promise<string>(() => {}));

    void start(pane);
    await flush();
    expect(pane.hasLiveSession()).toBe(true);
  });

  it("closes a session that finishes opening after the pane was disposed", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);
    let resolveConnect: (id: string) => void = () => {};
    vi.mocked(connect).mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveConnect = resolve)),
    );
    vi.mocked(disconnect).mockClear();

    void start(pane);
    await flush();
    pane.dispose();
    resolveConnect(h.sessionId);
    await flush();

    expect(vi.mocked(disconnect)).toHaveBeenCalledWith(h.sessionId);
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

  it("Cancel closes the reconnect attempt that is still handshaking", async () => {
    distinctSessionIds();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await dropThenReconnectAttempt(pane);
    vi.mocked(disconnect).mockClear();

    q<HTMLButtonElement>(root, ".overlay-cancel").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();

    expect(vi.mocked(disconnect)).toHaveBeenCalledWith("s2");
    h.statusHandler?.({ sessionId: "s2", status: "connected" }); // too late: ignored
    expect(pane.isConnected()).toBe(false);
    expect(pane.hasLiveSession()).toBe(false);
  });

  it("Retry after Cancel runs only the new session", async () => {
    distinctSessionIds();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
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

  it("a manual connect closes the session it replaces", async () => {
    distinctSessionIds();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);
    await start(pane); // s1 opened, not yet connected
    await flush();
    vi.mocked(disconnect).mockClear();

    await start(pane); // e.g. Connect clicked again from a stale overlay
    await flush();

    expect(vi.mocked(disconnect)).toHaveBeenCalledWith("s1");
  });

  it("a cancelled attempt that finishes opening afterwards is closed", async () => {
    distinctSessionIds();
    const root = q<HTMLElement>(document, "#pane-root");
    const pane = new TerminalPane(root);
    await pane.init();
    pane.assignDevice(h.device.id);
    let resolveS2: (id: string) => void = () => {};
    vi.mocked(connect)
      .mockImplementationOnce(async (id: string) => id) // s1
      .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveS2 = resolve)));
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: "s1", status: "connected" });
    h.statusHandler?.({ sessionId: "s1", status: "disconnected" });
    await vi.advanceTimersByTimeAsync(2000); // s2: connect() still in flight
    await flush();

    q<HTMLButtonElement>(root, ".overlay-cancel").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    vi.mocked(disconnect).mockClear();
    resolveS2("s2");
    await flush();

    expect(vi.mocked(disconnect)).toHaveBeenCalledWith("s2");
    expect(pane.hasLiveSession()).toBe(false);
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
    const pane = new TerminalPane(root, { getTerminalSettings: () => current });
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
    const pane = new TerminalPane(root, {
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
    const pane = new TerminalPane(q<HTMLElement>(document, "#pane-root"));
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
    const pane = new TerminalPane(q<HTMLElement>(document, "#pane-root"));
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
    const pane = new TerminalPane(root);
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
    const pane = new TerminalPane(root);
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
    const pane = new TerminalPane(root, { onInput });
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
    const pane = new TerminalPane(root, { onInput });
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
    const pane = new TerminalPane(root, { onInput });
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
    const pane = new TerminalPane(root);
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await (pane as unknown as { startSession(): Promise<void> }).startSession();
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });
    return { root, pane };
  }

  it("starts idle, labelled Idle", async () => {
    const root = q<HTMLElement>(document, "#pane-root");
    await new TerminalPane(root).init();

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
    const pane = new TerminalPane(root);
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
    const pane = new TerminalPane(root, { onStatusChange });
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
    const pane = new TerminalPane(root);
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
    const pane = new TerminalPane(root);
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await start(pane);
    await flush();
    h.statusHandler?.({ sessionId: h.sessionId, status: "connected" });

    vi.mocked(listDevices).mockRejectedValueOnce({ code: "ipc", message: "busy" });
    await pane.refreshDevices();

    expect(vi.mocked(disconnect)).not.toHaveBeenCalled();
    expect(pane.getDeviceId()).toBe(h.device.id);
    expect(pane.isConnected()).toBe(true);
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
    const pane = new TerminalPane(root);
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
    const pane = new TerminalPane(root, { onError });
    await pane.init();
    q<HTMLSelectElement>(root, ".pane-device-select").value = h.device.id;
    await connectPane(pane);
    q<HTMLButtonElement>(root, ".pane-save-output").click();
    await flush();
    expect(onError).toHaveBeenCalledWith("disk full");
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
    const pane = new TerminalPane(root);
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
