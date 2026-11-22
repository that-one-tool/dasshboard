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
    showConnecting: vi.fn(),
    syncPicker: vi.fn(),
    clearIdle: vi.fn(),
    persist: vi.fn(),
    onSettled: vi.fn(),
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

  it("shows the connecting state while the connect is in flight", async () => {
    const pending = deferred<string>();
    vi.mocked(sftpConnect).mockReturnValueOnce(pending.promise);
    const { deps, connection } = setup();
    const selecting = connection.select("a");
    await vi.waitFor(() => expect(deps.showConnecting).toHaveBeenCalledWith("a"));
    expect(deps.onConnected).not.toHaveBeenCalled();
    pending.resolve("/home/j");
    await selecting;
    expect(deps.showConnecting).toHaveBeenCalledOnce();
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

  /** The next close waits; the panel is already free for another action. */
  function holdClose(): () => void {
    const pending = deferred<void>();
    vi.mocked(sftpDisconnect).mockReturnValueOnce(pending.promise);
    return () => pending.resolve();
  }

  const connectedTo = (): string[] => vi.mocked(sftpConnect).mock.calls.map(([deviceId]) => deviceId);

  it("restart closes the connection and opens it again", async () => {
    const { session, connection } = setup();
    await connection.select("a");
    await connection.restart("a");
    expect(sftpDisconnect).toHaveBeenCalledExactlyOnceWith("a");
    expect(connectedTo()).toEqual(["a", "a"]);
    expect(session.activeDeviceId).toBe("a");
  });

  it("restart does not connect behind a panel closed during the close", async () => {
    const { session, connection } = setup();
    await connection.select("a");
    const finishClose = holdClose();
    const restarting = connection.restart("a");
    await Promise.resolve();
    await Promise.resolve();
    await connection.disconnectActive(); // what hiding the panel does
    finishClose();
    await restarting;
    expect(connectedTo()).toEqual(["a"]);
    expect(session.isConnected()).toBe(false);
  });

  it("restart leaves alone the device picked during the close", async () => {
    const { session, connection } = setup();
    await connection.select("a");
    const finishClose = holdClose();
    const restarting = connection.restart("a");
    await vi.waitFor(() => expect(sftpDisconnect).toHaveBeenCalled());
    await connection.select("b");
    finishClose();
    await restarting;
    expect(connectedTo()).toEqual(["a", "b"]);
    expect(session.activeDeviceId).toBe("b");
  });

  it("restart does nothing once the panel moved on during the confirm", async () => {
    const answer = deferred<boolean>();
    const { session, connection } = setup(1);
    await connection.select("a");
    vi.mocked(confirm).mockReturnValueOnce(answer.promise);
    const restarting = connection.restart("a");
    await connection.disconnectActive();
    answer.resolve(true);
    await restarting;
    expect(connectedTo()).toEqual(["a"]);
    expect(session.isConnected()).toBe(false);
  });

  it("restart ignores a device that is not the one connected", async () => {
    const { connection } = setup();
    await connection.select("a");
    await connection.restart("b");
    expect(sftpDisconnect).not.toHaveBeenCalled();
    expect(connectedTo()).toEqual(["a"]);
  });

  it("restart, like the toggle, waits out the first listing", async () => {
    const listing = deferred<void>();
    const { deps, connection } = setup();
    deps.onConnected.mockReturnValueOnce(listing.promise as Promise<void>);
    const selecting = connection.select("a");
    await vi.waitFor(() => expect(deps.onConnected).toHaveBeenCalled());
    await connection.restart("a");
    expect(sftpDisconnect).not.toHaveBeenCalled();
    listing.resolve();
    await selecting;
    expect(connectedTo()).toEqual(["a"]);
  });

  it("switching does not connect behind a panel closed during the close", async () => {
    const { session, deps, connection } = setup();
    await connection.select("a");
    const finishClose = holdClose();
    const switching = connection.select("b");
    await vi.waitFor(() => expect(sftpDisconnect).toHaveBeenCalled());
    await connection.disconnectActive();
    finishClose();
    await switching;
    expect(connectedTo()).toEqual(["a"]);
    expect(session.isConnected()).toBe(false);
    expect(deps.syncPicker).toHaveBeenCalledTimes(2); // back on the device picked
  });

  it("switching leaves alone another device picked during the close", async () => {
    const { session, connection } = setup();
    await connection.select("a");
    const finishClose = holdClose();
    const switching = connection.select("b");
    await vi.waitFor(() => expect(sftpDisconnect).toHaveBeenCalled());
    await connection.select("c");
    finishClose();
    await switching;
    expect(connectedTo()).toEqual(["a", "c"]);
    expect(session.activeDeviceId).toBe("c");
  });

  it("settles only once the first listing is done", async () => {
    const listing = deferred<void>();
    const { session, deps, connection } = setup();
    deps.onConnected.mockReturnValueOnce(listing.promise as Promise<void>);
    deps.onSettled.mockImplementation(() => expect(session.connecting).toBe(false));
    const selecting = connection.select("a");
    await vi.waitFor(() => expect(deps.onConnected).toHaveBeenCalled());
    expect(deps.onSettled).not.toHaveBeenCalled();
    listing.resolve();
    await selecting;
    expect(deps.onSettled).toHaveBeenCalledOnce();
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
