import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ErrorCode, OutputChunk, SessionStatus, SessionStatusEvent } from "../../ipc";

vi.mock("../../ipc", () => ({ logToBackend: vi.fn(), warnThrottled: vi.fn() }));

import { TerminalConnection, type ConnectionHost, type SessionTerminal } from "./terminalConnection";
import type { SessionsPort } from "./sessionsPort";
import { logToBackend } from "../../ipc";

interface PendingConnect {
  sessionId: string;
  deviceId: string;
  cols: number;
  rows: number;
  recordTo?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** The backend, scripted by each test: connects wait until resolved. */
class FakeSessions implements SessionsPort {
  readonly connects: PendingConnect[] = [];
  readonly closed: string[] = [];
  readonly written: Array<[string, string]> = [];
  readonly resized: Array<[string, number, number]> = [];
  readonly reads: Array<{ sessionId: string; from: number; reply: (chunk: OutputChunk) => void }> = [];
  writeReply: () => Promise<void> = async () => {};
  disconnectReply: () => Promise<void> = async () => {};
  listening = false;
  private handler: ((event: SessionStatusEvent) => void) | null = null;
  private count = 0;

  newSessionId(): string {
    this.count += 1;
    return `s${this.count}`;
  }

  connect(sessionId: string, deviceId: string, cols: number, rows: number, recordTo?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.connects.push({ sessionId, deviceId, cols, rows, recordTo, resolve: () => resolve(sessionId), reject });
    });
  }

  disconnect(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
    return this.disconnectReply();
  }

  readOutput(sessionId: string, from: number): Promise<OutputChunk> {
    return new Promise((reply) => this.reads.push({ sessionId, from, reply }));
  }

  writeStdin(sessionId: string, data: string): Promise<void> {
    this.written.push([sessionId, data]);
    return this.writeReply();
  }

  async writeStdinBinary(sessionId: string, data: string): Promise<void> {
    this.written.push([sessionId, `binary:${data}`]);
  }

  async resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
    this.resized.push([sessionId, cols, rows]);
  }

  async onSessionStatus(handler: (event: SessionStatusEvent) => void): Promise<() => void> {
    this.handler = handler;
    this.listening = true;
    return () => {
      this.listening = false;
      this.handler = null;
    };
  }

  status(sessionId: string, status: SessionStatus, message?: string, code?: ErrorCode): void {
    this.handler?.({ sessionId, status, message, code });
  }

  last(): PendingConnect {
    const pending = this.connects.at(-1);
    if (!pending) throw new Error("test: no connect");
    return pending;
  }
}

class FakeTerminal implements SessionTerminal {
  cols = 80;
  rows = 24;
  readonly shown: string[] = [];

  async write(bytes: Uint8Array): Promise<void> {
    this.shown.push(new TextDecoder().decode(bytes));
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const chunk = (text: string, start = 0): OutputChunk => ({
  start,
  bytes: new TextEncoder().encode(text),
  end: false,
});

describe("TerminalConnection", () => {
  let backend: FakeSessions;
  let host: ConnectionHost & {
    device: string | null;
    autoReconnect: boolean;
    terminals: FakeTerminal[];
    errors: string[];
    attempts: string[];
    changes: number;
  };
  let connection: TerminalConnection;

  beforeEach(async () => {
    vi.useFakeTimers();
    backend = new FakeSessions();
    host = {
      device: "dev-1",
      autoReconnect: true,
      terminals: [],
      errors: [],
      attempts: [],
      changes: 0,
      deviceId: () => host.device,
      autoReconnectEnabled: () => host.autoReconnect,
      deviceName: () => "NAS",
      recordTo: () => undefined,
      openTerminal: () => {
        const terminal = new FakeTerminal();
        host.terminals.push(terminal);
        return terminal;
      },
      onAttempt: (deviceId) => host.attempts.push(deviceId),
      onError: (message) => host.errors.push(message),
      onChange: () => (host.changes += 1),
    };
    connection = new TerminalConnection(backend, host);
    await connection.listen();
  });

  afterEach(() => vi.useRealTimers());

  /** Opens `s1`: connect returns, then the backend reports it connected. */
  async function connected(): Promise<void> {
    const opening = connection.connect("dev-1");
    backend.last().resolve();
    await opening;
    backend.status(backend.last().sessionId, "connected");
  }

  async function connectedThenDropped(): Promise<void> {
    await connected();
    backend.status("s1", "disconnected");
  }

  /** The reconnect timer fires: its attempt is opening, not yet returned. */
  async function reconnectFires(): Promise<void> {
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
  }

  async function staysDown(): Promise<void> {
    const before = backend.connects.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.connects.length).toBe(before);
  }

  describe("connect", () => {
    it("opens a session on the device at the new terminal's size, showing connecting", async () => {
      void connection.connect("dev-1");

      expect(backend.last()).toMatchObject({ sessionId: "s1", deviceId: "dev-1", cols: 80, rows: 24 });
      expect(host.attempts).toEqual(["dev-1"]);
      expect(connection.state()).toMatchObject({
        status: "connecting",
        live: true,
        locked: true,
        notice: { kind: "status", status: "connecting" },
      });
    });

    it("ignores a second connect while the first is still opening", async () => {
      const first = connection.connect("dev-1");
      const second = connection.connect("dev-1");
      backend.last().resolve();
      await Promise.all([first, second]);

      expect(backend.connects).toHaveLength(1);
      expect(host.terminals).toHaveLength(1);
      expect(connection.state().live).toBe(true);
    });

    it("with no device, only closes what was open", async () => {
      await connected();

      await connection.connect(null);

      expect(backend.closed).toEqual(["s1"]);
      expect(backend.connects).toHaveLength(1);
      expect(connection.state().live).toBe(false);
    });

    it("records into the host's recording file", () => {
      host.recordTo = () => "/rec.log";
      void connection.connect("dev-1");
      expect(backend.last().recordTo).toBe("/rec.log");
    });

    it("is connected, unlocked for input, once the backend says so", async () => {
      await connected();
      expect(connection.state()).toMatchObject({
        status: "connected",
        open: true,
        connected: true,
        notice: { kind: "status", status: "connected" },
      });
    });

    it("reports a failed connect, unlocking the device", async () => {
      host.autoReconnect = false;
      const opening = connection.connect("dev-1");
      backend.last().reject({ code: "SshConnect", message: "refused" });
      await opening;

      expect(host.errors).toEqual(["refused"]);
      expect(connection.state()).toMatchObject({
        status: "error",
        locked: false,
        notice: { kind: "status", status: "error", message: "refused" },
      });
    });

    it("honors a failure that arrives before connect() returns", async () => {
      host.autoReconnect = false;
      const opening = connection.connect("dev-1");
      backend.status("s1", "error", "COM3 not found");
      backend.last().resolve();
      await opening;

      expect(connection.state().notice).toEqual({ kind: "status", status: "error", message: "COM3 not found" });
      expect(connection.state().live).toBe(false);
      expect(backend.closed).toEqual(["s1"]);
    });

    it("honors a connected status that arrives before connect() returns", async () => {
      const opening = connection.connect("dev-1");
      backend.status("s1", "connected");
      connection.resize(132, 43);
      backend.last().resolve();
      await opening;

      expect(backend.resized).toEqual([["s1", 132, 43]]);
      expect(connection.state().connected).toBe(true);
    });

    it("counts a connect in flight as a live session", () => {
      void connection.connect("dev-1");
      expect(connection.state().live).toBe(true);
      expect(connection.ownsSession("s1")).toBe(true);
      expect(connection.sessionIds()).toEqual(["s1"]);
    });

    it("a manual connect closes the session it replaces", async () => {
      const opening = connection.connect("dev-1");
      backend.last().resolve();
      await opening;

      void connection.connect("dev-1");

      expect(backend.closed).toEqual(["s1"]);
      expect(connection.ownsSession("s1")).toBe(false);
    });

    it("ignores the events of a session it let go of", async () => {
      await connected();
      void connection.connect("dev-1");

      backend.status("s1", "disconnected");

      expect(connection.state().status).toBe("connecting");
      expect(backend.connects).toHaveLength(2);
    });
  });

  describe("output", () => {
    it("shows the session's output in its terminal, from offset 0", async () => {
      await connected();
      backend.reads[0]?.reply(chunk("$ "));
      await flush();

      expect(backend.reads[0]).toMatchObject({ sessionId: "s1", from: 0 });
      expect(host.terminals[0]?.shown).toEqual(["$ "]);
    });

    it("output from a replaced session never reaches the new terminal", async () => {
      await connected();
      const opening = connection.connect("dev-1");
      backend.last().resolve();
      await opening;

      backend.reads[0]?.reply(chunk("stale"));
      await flush();

      expect(host.terminals[1]?.shown).toEqual([]);
      expect(host.terminals[0]?.shown).toEqual([]);
    });
  });

  describe("input", () => {
    it("sends only once connected", async () => {
      expect(connection.send("nope")).toBe(false);
      void connection.connect("dev-1");
      expect(connection.send("nope")).toBe(false);
      backend.last().resolve();
      await flush();
      backend.status("s1", "connected");

      expect(connection.send("ls\r")).toBe(true);
      connection.sendBinary("\x80");
      await flush();
      expect(backend.written).toEqual([
        ["s1", "ls\r"],
        ["s1", "binary:\x80"],
      ]);
    });

    it("drops binary input with no connected session", () => {
      connection.sendBinary("\x80");
      expect(backend.written).toEqual([]);
    });

    it("a session sender sends only while that same session is live", async () => {
      await connected();
      const send = connection.senderForCurrentSession();
      send("a");
      backend.status("s1", "disconnected");
      send("b");
      void connection.connect("dev-1");
      backend.last().resolve();
      await flush();
      backend.status("s2", "connected");
      send("c");
      await flush();

      expect(backend.written).toEqual([["s1", "a"]]);
    });

    it("reports input that stopped getting through, then a new session starts fresh", async () => {
      await connected();
      backend.writeReply = () => Promise.reject(new Error("ipc failed"));
      connection.send("a");
      await flush();
      expect(connection.state().inputHealth).toBe("lost");

      backend.writeReply = async () => {};
      void connection.connect("dev-1");
      expect(connection.state().inputHealth).toBe("ok");
      backend.last().resolve();
      await flush();
      backend.status("s2", "connected");
      connection.send("b");
      await flush();
      expect(backend.written.at(-1)).toEqual(["s2", "b"]);
    });

    it("an old session's input health no longer counts", async () => {
      await connected();
      backend.writeReply = () => Promise.reject(new Error("ipc failed"));
      connection.send("a");
      void connection.connect("dev-1");
      await flush();

      expect(connection.state().inputHealth).toBe("ok");
    });
  });

  describe("resize", () => {
    it("resizes the connected session only", async () => {
      connection.resize(100, 30);
      await connected();
      connection.resize(120, 40);
      backend.status("s1", "disconnected");
      connection.resize(90, 20);

      expect(backend.resized).toEqual([["s1", 120, 40]]);
    });
  });

  describe("auto-reconnect", () => {
    it("schedules a backoff reconnect on an unexpected drop and retries when it fires", async () => {
      await connectedThenDropped();
      expect(connection.state()).toMatchObject({
        status: "connecting",
        open: false,
        notice: { kind: "reconnecting", attempt: 1 },
      });

      await reconnectFires();
      expect(backend.connects).toHaveLength(2);
      expect(backend.last().deviceId).toBe("dev-1");
    });

    it("does not reconnect a device that didn't opt in", async () => {
      host.autoReconnect = false;
      await connectedThenDropped();

      expect(connection.state().notice).toEqual({ kind: "status", status: "disconnected" });
      await staysDown();
    });

    it("does not reconnect a wrong password or a rejected host key (lockout, re-prompts)", async () => {
      for (const code of ["SshAuth", "HostKeyRejected"] as const) {
        const opening = connection.connect("dev-1");
        backend.last().resolve();
        await opening;
        backend.status(backend.last().sessionId, "error", "it failed", code);

        expect(connection.state().notice, code).toEqual({
          kind: "status",
          status: "error",
          message: "it failed",
        });
        await staysDown();
      }
    });

    it("retries a first connect that couldn't reach the server (e.g. down at launch)", async () => {
      const opening = connection.connect("dev-1");
      backend.last().reject({ code: "SshConnect", message: "refused" });
      await opening;

      expect(connection.state().notice).toEqual({ kind: "reconnecting", attempt: 1 });
    });

    it("retries a keychain failure once, then stops", async () => {
      void connection.connect("dev-1");
      backend.status("s1", "error", "locked", "Keyring");
      expect(connection.state().notice).toEqual({ kind: "reconnecting", attempt: 1 });

      await reconnectFires();
      backend.status("s2", "error", "locked", "Keyring");

      await staysDown();
    });

    it("keeps reconnecting when a reconnect attempt can't reach the server", async () => {
      await connectedThenDropped();
      await reconnectFires();
      backend.status("s2", "error", "refused", "SshConnect");

      expect(connection.state().notice).toEqual({ kind: "reconnecting", attempt: 2 });
    });

    it("the backend's own connecting status keeps the attempt on show", async () => {
      await connectedThenDropped();
      await reconnectFires();
      backend.status("s2", "connecting");

      expect(connection.state().notice).toEqual({ kind: "reconnecting", attempt: 1 });
    });

    it("stops reconnecting when an attempt is refused by the server's auth", async () => {
      await connectedThenDropped();
      await reconnectFires();
      backend.status("s2", "error", "auth failed", "SshAuth");

      await staysDown();
    });

    it("gives a later drop a full budget once back up", async () => {
      await connectedThenDropped();
      await reconnectFires();
      backend.last().resolve();
      await flush();
      backend.status("s2", "connected");
      backend.status("s2", "disconnected");

      expect(connection.state().notice).toEqual({ kind: "reconnecting", attempt: 1 });
    });

    it("does not reconnect a shell that exited on its own (exit / logout)", async () => {
      await connected();
      backend.status("s1", "exited");

      expect(connection.state()).toMatchObject({
        status: "exited",
        live: false,
        notice: { kind: "status", status: "exited" },
      });
      await staysDown();
    });

    it("does not reconnect a user-initiated disconnect", async () => {
      await connected();
      await connection.disconnect();
      backend.status("s1", "disconnected");

      expect(backend.closed).toEqual(["s1"]);
      expect(connection.state().notice).toEqual({ kind: "status", status: "disconnected" });
      await staysDown();
    });

    it("reconnects a later unexpected drop after a user disconnect", async () => {
      await connected();
      await connection.disconnect();
      backend.status("s1", "disconnected");
      await connected();
      backend.status("s2", "disconnected");

      expect(connection.state().notice).toEqual({ kind: "reconnecting", attempt: 1 });
    });

    it("a manual connect during the reconnect wait replaces the pending attempt", async () => {
      await connectedThenDropped();

      void connection.connect("dev-1");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(backend.connects).toHaveLength(2);
    });

    it("a reconnect whose device was unassigned says so instead of connecting", async () => {
      await connectedThenDropped();
      host.device = null;
      await reconnectFires();

      expect(backend.connects).toHaveLength(1);
      expect(connection.state().notice).toEqual({ kind: "deviceGone" });
      expect(connection.state().locked).toBe(false);
      await staysDown();
    });

    it("dispose() cancels a pending reconnect (no attempt after teardown)", async () => {
      await connectedThenDropped();
      connection.dispose();
      await staysDown();
    });

    it("abandoning the device closes the session still opening instead of adopting it", async () => {
      const attempt = connection.connect("dev-1");
      const { sessionId, resolve } = backend.last();

      connection.abandon();
      expect(backend.closed).toContain(sessionId);

      resolve();
      await attempt;
      backend.status(sessionId, "connected");
      expect(connection.state()).toMatchObject({ status: "idle", live: false, connected: false });
    });

    it("abandoning the device cancels a reconnect and ends idle", async () => {
      await connectedThenDropped();
      connection.abandon();

      expect(connection.state()).toMatchObject({ status: "idle", notice: { kind: "hidden" } });
      await staysDown();
    });
  });

  describe("cancel", () => {
    it("stops a pending reconnect and reads disconnected", async () => {
      await connectedThenDropped();
      connection.cancel();

      expect(connection.state()).toMatchObject({
        status: "disconnected",
        notice: { kind: "reconnectCancelled" },
      });
      await staysDown();
    });

    it("closes the reconnect attempt that is still handshaking", async () => {
      await connectedThenDropped();
      await reconnectFires();
      backend.last().resolve();
      await flush();

      connection.cancel();
      backend.status("s2", "connected"); // too late: ignored

      expect(backend.closed).toContain("s2");
      expect(connection.state()).toMatchObject({ connected: false, live: false });
    });

    it("Retry after Cancel runs only the new session", async () => {
      await connectedThenDropped();
      await reconnectFires();
      backend.last().resolve();
      await flush();
      connection.cancel();

      void connection.connect("dev-1");
      backend.last().resolve();
      await flush();
      backend.status("s2", "error", "late");
      backend.status("s3", "connected");

      expect(connection.state().connected).toBe(true);
      await staysDown();
    });

    it("a cancelled attempt that finishes opening afterwards is closed", async () => {
      await connectedThenDropped();
      await reconnectFires();
      connection.cancel();
      backend.closed.length = 0;

      backend.last().resolve();
      await flush();

      expect(backend.closed).toEqual(["s2"]);
      expect(connection.state().live).toBe(false);
    });

    it("an in-flight attempt that fails after Cancel does not resume auto-reconnect", async () => {
      await connectedThenDropped();
      await reconnectFires();
      connection.cancel();

      backend.last().reject({ code: "SshConnect", message: "boom" });
      await flush();

      expect(connection.state().notice).toEqual({ kind: "reconnectCancelled" });
      expect(host.errors).toEqual([]);
      await staysDown();
    });
  });

  describe("dispose", () => {
    it("closes the live session and stops listening", async () => {
      await connected();
      connection.dispose();

      expect(backend.closed).toEqual(["s1"]);
      expect(backend.listening).toBe(false);
      expect(connection.state()).toMatchObject({ status: "idle", live: false });
    });

    it("closes a session that finishes opening after dispose", async () => {
      void connection.connect("dev-1");
      connection.dispose();
      backend.last().resolve();
      await flush();

      expect(backend.closed).toEqual(["s1"]);
      expect(connection.state().live).toBe(false);
    });

    it("reports the change once", async () => {
      await connected();
      host.changes = 0;
      connection.dispose();
      expect(host.changes).toBe(1);
    });

    it("stops listening when disposed before listening started", async () => {
      const fresh = new FakeSessions();
      const late = new TerminalConnection(fresh, host);
      const listening = late.listen();
      late.dispose();
      await listening;

      expect(fresh.listening).toBe(false);
    });

    it("a connect failing after dispose reports nothing", async () => {
      void connection.connect("dev-1");
      connection.dispose();
      host.changes = 0;
      backend.last().reject({ code: "SshConnect", message: "boom" });
      await flush();

      expect(host.errors).toEqual([]);
      expect(connection.state().status).toBe("idle");
    });

    it("does not read output of a session that finishes opening after dispose", async () => {
      void connection.connect("dev-1");
      connection.dispose();
      backend.last().resolve();
      await flush();

      expect(backend.reads).toEqual([]);
    });
  });

  describe("disconnect", () => {
    it("a drop after Disconnect stays down even when connected arrives late", async () => {
      const opening = connection.connect("dev-1");
      backend.last().resolve();
      await opening;
      await connection.disconnect();
      backend.status("s1", "connected");
      backend.status("s1", "disconnected");

      expect(connection.state().notice).toMatchObject({ kind: "status", status: "disconnected" });
      await staysDown();
    });

    it("logs a close that fails instead of rejecting", async () => {
      await connected();
      backend.disconnectReply = () => Promise.reject(new Error("backend gone"));

      await expect(connection.disconnect()).resolves.toBeUndefined();
      expect(logToBackend).toHaveBeenCalledWith("warn", expect.stringContaining("backend gone"));
    });
  });
});
