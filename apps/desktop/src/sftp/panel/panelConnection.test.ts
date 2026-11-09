/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ live: ["a"] as string[], confirmed: true }));

vi.mock("../../ipc", () => ({
  sftpConnect: vi.fn(async () => "/home/j"),
  sftpDisconnect: vi.fn(async () => {}),
  sftpConnectedDevices: vi.fn(async () => h.live),
}));
vi.mock("../../ui/confirm", () => ({ confirm: vi.fn(async () => h.confirmed) }));

import { sftpConnect, sftpConnectedDevices, sftpDisconnect } from "../../ipc";
import { confirm } from "../../ui/confirm";
import { t } from "../../i18n";
import { DirHistory } from "./dirHistory";
import { PanelConnection } from "./panelConnection";
import { PanelControls } from "./panelControls";
import { buildPanelElements } from "./panelElements";
import { PanelFeedback } from "./panelFeedback";
import { PanelSession } from "./panelSession";

function setup(unsynced = 0) {
  const els = buildPanelElements(document.createElement("aside"));
  const session = new PanelSession();
  const history = new DirHistory();
  const hooks = { notifyError: vi.fn(), notifySuccess: vi.fn(), resync: vi.fn() };
  const deps = {
    session,
    controls: new PanelControls(() => els, session, history),
    history,
    feedback: new PanelFeedback(hooks),
    unsyncedEdits: vi.fn(() => unsynced),
    onConnected: vi.fn(async () => {}),
    onReleased: vi.fn(),
    showDisconnected: vi.fn(),
    syncPicker: vi.fn(),
    clearIdle: vi.fn(),
    persist: vi.fn(),
  };
  return { els, session, hooks, deps, connection: new PanelConnection(deps) };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PanelConnection", () => {
  beforeEach(() => {
    h.live = ["a"];
    h.confirmed = true;
    vi.clearAllMocks();
  });

  it("select connects, then hands the start directory on", async () => {
    const { els, session, deps, connection } = setup();
    await connection.select("a");
    expect(sftpConnect).toHaveBeenCalledWith("a");
    expect(session.activeDeviceId).toBe("a");
    expect(session.selectedDeviceId).toBe("a");
    expect(deps.onConnected).toHaveBeenCalledWith("a", "/home/j");
    expect(session.connecting).toBe(false);
    expect(deps.controls.isBusy()).toBe(false);
    expect(deps.persist).toHaveBeenCalled();
    expect(els.connToggle.classList.contains("is-connected")).toBe(true);
  });

  it("select does nothing for the device already shown", async () => {
    const { connection } = setup();
    await connection.select("a");
    await connection.select("a");
    expect(sftpConnect).toHaveBeenCalledOnce();
  });

  it("switching devices disconnects the previous one first", async () => {
    const { deps, connection } = setup();
    await connection.select("a");
    await connection.select("b");
    expect(sftpDisconnect).toHaveBeenCalledWith("a");
    expect(deps.onReleased).toHaveBeenCalledWith("a");
    expect(sftpConnect).toHaveBeenLastCalledWith("b");
  });

  it("keeps the device when unsynced edits make the user decline", async () => {
    const { session, deps, connection } = setup(2);
    await connection.select("a");
    h.confirmed = false;
    await connection.select("b");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("2"));
    expect(session.activeDeviceId).toBe("a");
    expect(deps.syncPicker).toHaveBeenCalled();
    expect(sftpConnect).toHaveBeenCalledOnce();
  });

  it("a failed connect is reported and shows the disconnected state", async () => {
    vi.mocked(sftpConnect).mockRejectedValueOnce({ code: "SshConnect", message: "refused" });
    const { els, session, hooks, deps, connection } = setup();
    await connection.select("a");
    expect(session.activeDeviceId).toBeNull();
    expect(hooks.notifyError).toHaveBeenCalledWith({ code: "SshConnect", message: "refused" });
    expect(hooks.resync).not.toHaveBeenCalled();
    expect(deps.showDisconnected).toHaveBeenCalled();
    expect(els.status.textContent).toBe("");
  });

  it("closes a connection that opened after the user disconnected", async () => {
    const pending = deferred<string>();
    vi.mocked(sftpConnect).mockReturnValueOnce(pending.promise);
    const { session, deps, connection } = setup();
    const selecting = connection.select("a");
    await vi.waitFor(() => expect(session.connecting).toBe(true));
    await connection.disconnectActive();
    pending.resolve("/home/j");
    await selecting;
    expect(sftpDisconnect).toHaveBeenCalledWith("a");
    expect(deps.onConnected).not.toHaveBeenCalled();
    expect(session.activeDeviceId).toBeNull();
  });

  it("a superseded connect that fails leaves the newer one alone", async () => {
    const first = deferred<string>();
    vi.mocked(sftpConnect).mockReturnValueOnce(first.promise);
    const { session, hooks, connection } = setup();
    const selectingA = connection.select("a");
    await connection.select("b");
    first.reject({ code: "SshConnect", message: "timed out" });
    await selectingA;
    expect(session.activeDeviceId).toBe("b");
    expect(hooks.notifyError).not.toHaveBeenCalled();
  });

  it("toggle disconnects a connected panel and reconnects the selected device", async () => {
    const { session, deps, connection } = setup();
    await connection.select("a");
    connection.toggle();
    await vi.waitFor(() => expect(session.activeDeviceId).toBeNull());
    expect(deps.clearIdle).toHaveBeenCalled();
    expect(deps.showDisconnected).toHaveBeenCalled();

    connection.toggle();
    await vi.waitFor(() => expect(session.activeDeviceId).toBe("a"));
    expect(sftpConnect).toHaveBeenCalledTimes(2);
  });

  it("toggle does nothing mid-connect or with no device selected", () => {
    const { session, connection } = setup();
    connection.toggle();
    session.pickDevice("a");
    session.startConnecting();
    connection.toggle();
    expect(sftpConnect).not.toHaveBeenCalled();
  });

  it("disconnect clears the idle flag and the status", async () => {
    const { els, session, connection } = setup();
    await connection.select("a");
    session.markIdleDisconnected();
    await connection.disconnect();
    expect(session.idleDisconnected).toBe(false);
    expect(els.status.textContent).toBe("");
    expect(els.connToggle.classList.contains("is-disconnected")).toBe(true);
  });

  it("disconnectActive is best-effort and safe while disconnected", async () => {
    const { deps, connection } = setup();
    await connection.disconnectActive();
    expect(deps.onReleased).toHaveBeenCalledWith(null);
    expect(sftpDisconnect).not.toHaveBeenCalled();

    await connection.select("a");
    vi.mocked(sftpDisconnect).mockRejectedValueOnce(new Error("gone"));
    await expect(connection.disconnectActive()).resolves.toBeUndefined();
  });

  it("confirmEndEdits asks only with unsynced edits", async () => {
    const clean = setup(0);
    await clean.connection.select("a");
    expect(await clean.connection.confirmEndEdits()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    const dirty = setup(1);
    await dirty.connection.select("a");
    h.confirmed = false;
    expect(await dirty.connection.confirmEndEdits()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(t("sftp.edit.disconnectConfirm.one", { count: 1 }));
  });

  it("resync drops a connection the backend lost, and keeps a live one", async () => {
    const { session, connection } = setup();
    await connection.select("a");
    await connection.resync();
    expect(session.activeDeviceId).toBe("a");
    vi.mocked(sftpConnectedDevices).mockRejectedValueOnce(new Error("busy"));
    await connection.resync();
    expect(session.activeDeviceId).toBe("a");
    h.live = [];
    await connection.resync();
    expect(session.activeDeviceId).toBeNull();
  });

  it("resync does nothing while disconnected", async () => {
    const { connection } = setup();
    await connection.resync();
    expect(sftpConnectedDevices).not.toHaveBeenCalled();
  });
});
