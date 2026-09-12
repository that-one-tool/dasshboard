/**
 * @vitest-environment happy-dom
 *
 * DOM tests for the Files (SFTP) panel: the sidebar card lists SSH devices,
 * "Browse" connects and lists the home directory, clicking a directory descends,
 * clicking a file downloads, and closing disconnects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Device, SftpEntry } from "../ipc";

const h = vi.hoisted(() => ({
  devices: [] as Device[],
  listResult: [] as SftpEntry[],
  saveResult: null as string | null,
  openResult: null as string | null,
}));

vi.mock("../ipc", () => ({
  listDevices: vi.fn(async () => h.devices),
  sftpConnect: vi.fn(async () => "/home/j"),
  sftpDisconnect: vi.fn(async () => {}),
  sftpList: vi.fn(async () => h.listResult),
  sftpRealpath: vi.fn(async (_id: string, p: string) => p.replace(/\/\.\.$/, "")),
  sftpDownload: vi.fn(async () => 123),
  sftpUpload: vi.fn(async () => 10),
  sftpMkdir: vi.fn(async () => {}),
  sftpRename: vi.fn(async () => {}),
  sftpRemove: vi.fn(async () => {}),
}));

vi.mock("../ui/fileDialog", () => ({
  pickDownloadSavePath: vi.fn(async () => h.saveResult),
  pickUploadOpenPath: vi.fn(async () => h.openResult),
}));

vi.mock("../ui/confirm", () => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => "newname"),
}));

vi.mock("@tauri-apps/api/path", () => ({
  basename: vi.fn(async (p: string) => p.split(/[\\/]/).pop() ?? p),
}));

import { SftpPanel, browsableDevices } from "./sftpPanel";
import { sftpConnect, sftpList, sftpDisconnect, sftpDownload } from "../ipc";

function sshDevice(id: string, name: string): Device {
  return {
    id,
    name,
    kind: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    auth: { method: "password" },
    forwards: [],
    tunnelAutoStart: false,
    autoReconnect: false,
  } as Device;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function q<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

async function setup(): Promise<SftpPanel> {
  document.body.innerHTML = `<div class="sftp-list"></div>`;
  const panel = new SftpPanel();
  await panel.init();
  await flush();
  return panel;
}

describe("browsableDevices", () => {
  it("keeps only SSH devices", () => {
    const devices = [
      sshDevice("a", "A"),
      { id: "s", name: "serial", kind: "serial" } as unknown as Device,
    ];
    expect(browsableDevices(devices).map((d) => d.id)).toEqual(["a"]);
  });
});

describe("SftpPanel", () => {
  beforeEach(() => {
    h.devices = [sshDevice("a", "Alpha")];
    h.listResult = [
      { name: "sub", kind: "dir", size: 0 },
      { name: "readme.txt", kind: "file", size: 42, modified: 1_700_000_000 },
    ];
    h.saveResult = null;
    h.openResult = null;
    vi.clearAllMocks();
  });

  it("renders a Browse button per SSH device", async () => {
    await setup();
    const rows = document.querySelectorAll(".sftp-device-row");
    expect(rows.length).toBe(1);
    expect(q(".sftp-device-name").textContent).toBe("Alpha");
  });

  it("Browse connects and lists the home directory", async () => {
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush();

    expect(sftpConnect).toHaveBeenCalledWith("a");
    expect(sftpList).toHaveBeenCalledWith("a", "/home/j");
    expect(q(".sftp-path").textContent).toBe("/home/j");
    // Two entries rendered (a dir and a file).
    expect(document.querySelectorAll(".sftp-entry").length).toBe(2);
  });

  it("clicking a directory descends into it", async () => {
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush();

    const dirName = document.querySelector<HTMLButtonElement>(
      ".sftp-entry.is-dir .sftp-entry-name",
    );
    dirName?.click();
    await flush();

    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j/sub");
  });

  it("clicking a file triggers a download when a save path is chosen", async () => {
    h.saveResult = "C:/local/readme.txt";
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush();

    const fileName = document.querySelector<HTMLButtonElement>(
      ".sftp-entry.is-file .sftp-entry-name",
    );
    fileName?.click();
    await flush();

    expect(sftpDownload).toHaveBeenCalledWith(
      "a",
      "/home/j/readme.txt",
      "C:/local/readme.txt",
    );
  });

  it("a cancelled save dialog does not download", async () => {
    h.saveResult = null;
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush();

    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-file .sftp-entry-name")
      ?.click();
    await flush();

    expect(sftpDownload).not.toHaveBeenCalled();
  });

  it("Back returns to the previous folder, Forward re-enters, without re-pushing", async () => {
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush(); // at /home/j

    // Descend into sub.
    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")
      ?.click();
    await flush(); // at /home/j/sub

    // Back → /home/j
    q<HTMLButtonElement>('.sftp-drawer [data-action="back"]').click();
    await flush();
    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j");
    expect(q(".sftp-path").textContent).toBe("/home/j");

    // Forward → /home/j/sub
    q<HTMLButtonElement>('.sftp-drawer [data-action="forward"]').click();
    await flush();
    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j/sub");
  });

  it("Back is disabled at the start of history and Forward at the end", async () => {
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush(); // home only → both ends

    const back = q<HTMLButtonElement>('.sftp-drawer [data-action="back"]');
    const forward = q<HTMLButtonElement>('.sftp-drawer [data-action="forward"]');
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);

    // Descend: Back enabled, Forward still disabled (no forward entry).
    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")
      ?.click();
    await flush();
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);

    // Back once: now Forward is enabled again.
    back.click();
    await flush();
    expect(forward.disabled).toBe(false);
  });

  it("navigating after going Back truncates the forward history", async () => {
    // home → sub, Back to home, then descend again: the old forward (sub) entry
    // is dropped, so Forward is disabled at the new leaf.
    h.listResult = [
      { name: "sub", kind: "dir", size: 0 },
      { name: "other", kind: "dir", size: 0 },
    ];
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush();
    document
      .querySelectorAll<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")[0]
      ?.click();
    await flush(); // /home/j/sub
    q<HTMLButtonElement>('.sftp-drawer [data-action="back"]').click();
    await flush(); // back at /home/j
    document
      .querySelectorAll<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")[1]
      ?.click();
    await flush(); // /home/j/other — truncates the sub forward entry

    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j/other");
    expect(
      q<HTMLButtonElement>('.sftp-drawer [data-action="forward"]').disabled,
    ).toBe(true);
  });

  it("a click landing on a toolbar button's SVG icon still navigates", async () => {
    // Regression: the delegated handler guarded on `HTMLElement`, but a click on
    // an inline SVG icon has an `SVGElement` target and was dropped.
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush();
    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")
      ?.click();
    await flush(); // at /home/j/sub, Back enabled

    const backSvg = document.querySelector(
      '.sftp-drawer [data-action="back"] svg',
    );
    expect(backSvg).not.toBeNull();
    backSvg?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j");
  });

  it("closing the drawer disconnects", async () => {
    await setup();
    q<HTMLButtonElement>(".sftp-device-row .btn").click();
    await flush();

    q<HTMLButtonElement>('.sftp-drawer [data-action="close"]').click();
    await flush();

    expect(sftpDisconnect).toHaveBeenCalledWith("a");
    expect(q(".sftp-drawer").classList.contains("dialog-hidden")).toBe(true);
  });
});
