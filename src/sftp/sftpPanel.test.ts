/**
 * @vitest-environment happy-dom
 *
 * DOM tests for the Files (SFTP) panel: the sidebar card lists SSH devices,
 * "Browse" opens the docked panel + connects, clicking a directory descends,
 * clicking a file downloads, collapsing keeps the connection while hiding /
 * disconnecting drops it, and an idle collapsed panel auto-disconnects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Device, SftpEntry, SftpProgressEvent } from "../ipc";

const h = vi.hoisted(() => ({
  devices: [] as Device[],
  listResult: [] as SftpEntry[],
  saveResult: null as string | null,
  openResult: null as string | null,
  progressHandler: null as ((e: SftpProgressEvent) => void) | null,
}));

vi.mock("../ipc", () => ({
  listDevices: vi.fn(async () => h.devices),
  sftpConnect: vi.fn(async () => "/home/j"),
  sftpDisconnect: vi.fn(async () => {}),
  sftpList: vi.fn(async () => h.listResult),
  sftpRealpath: vi.fn(async (_id: string, p: string) => {
    // Minimal POSIX canonicalize: collapse "." and ".." segments.
    const stack: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") stack.pop();
      else stack.push(seg);
    }
    return "/" + stack.join("/");
  }),
  sftpDownload: vi.fn(async () => 123),
  sftpUpload: vi.fn(async () => 10),
  sftpMkdir: vi.fn(async () => {}),
  sftpRename: vi.fn(async () => {}),
  sftpRemove: vi.fn(async () => {}),
  sftpCancelTransfer: vi.fn(async () => {}),
  onSftpProgress: vi.fn(async (handler: (e: SftpProgressEvent) => void) => {
    h.progressHandler = handler;
    return () => {};
  }),
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

import { SftpPanel, browsableDevices, type SftpPanelOptions } from "./sftpPanel";
import {
  sftpConnect,
  sftpList,
  sftpRealpath,
  sftpDisconnect,
  sftpDownload,
  sftpCancelTransfer,
} from "../ipc";
import type { AppError } from "../ipc";

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
    proxyJump: null,
    forwardAgent: false,
    autoReconnect: false,
    tags: [],
    connectSnippet: null,
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

/** The panel + splitter live in index.html; recreate that shell for the test. */
function mountShell(): void {
  document.body.innerHTML = `
    <button id="sftp-btn" aria-pressed="false"></button>
    <div class="workspace-row">
      <div id="pane-root" class="pane-root"></div>
      <div class="sftp-splitter" hidden></div>
      <aside class="sftp-panel" hidden></aside>
    </div>`;
}

/** The panel under test, so `browse()` can drive its picker. */
let activePanel: SftpPanel;

async function setup(options: SftpPanelOptions = {}): Promise<SftpPanel> {
  mountShell();
  const panel = new SftpPanel(options);
  await panel.init();
  await flush();
  activePanel = panel;
  return panel;
}

/** Open the panel and connect device "a" via the picker (common precondition). */
async function browse(): Promise<void> {
  activePanel.open();
  const select = q<HTMLSelectElement>(".sftp-device-select");
  select.value = "a";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
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

  it("shows the SFTP title in the panel header", async () => {
    await setup();
    expect(q(".sftp-panel-title").textContent).toBe("SFTP");
  });

  it("opening + selecting a device connects and lists the home directory", async () => {
    await setup();
    expect(q(".sftp-panel").hidden).toBe(true);
    await browse();

    expect(q(".sftp-panel").hidden).toBe(false);
    expect(q("#sftp-btn").getAttribute("aria-pressed")).toBe("true");
    expect(sftpConnect).toHaveBeenCalledWith("a");
    expect(sftpList).toHaveBeenCalledWith("a", "/home/j");
    expect(q<HTMLInputElement>(".sftp-path").value).toBe("/home/j");
    expect(document.querySelectorAll(".sftp-entry").length).toBe(2);
  });

  it("populates the device picker and selecting one connects", async () => {
    h.devices = [sshDevice("a", "Alpha"), sshDevice("b", "Beta")];
    const panel = await setup();
    const select = q<HTMLSelectElement>(".sftp-device-select");
    // Placeholder + two devices.
    expect(select.options.length).toBe(3);

    panel.toggle(); // open (no connection yet)
    await flush();
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(sftpConnect).toHaveBeenCalledWith("b");
  });

  it("clicking a directory descends into it", async () => {
    await setup();
    await browse();

    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")
      ?.click();
    await flush();

    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j/sub");
  });

  it("clicking a file triggers a download when a save path is chosen", async () => {
    h.saveResult = "C:/local/readme.txt";
    await setup();
    await browse();

    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-file .sftp-entry-name")
      ?.click();
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
    await browse();

    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-file .sftp-entry-name")
      ?.click();
    await flush();

    expect(sftpDownload).not.toHaveBeenCalled();
  });

  it("Back returns to the previous folder, Forward re-enters, without re-pushing", async () => {
    await setup();
    await browse(); // at /home/j

    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")
      ?.click();
    await flush(); // at /home/j/sub

    q<HTMLButtonElement>('.sftp-panel [data-action="back"]').click();
    await flush();
    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j");
    expect(q<HTMLInputElement>(".sftp-path").value).toBe("/home/j");

    q<HTMLButtonElement>('.sftp-panel [data-action="forward"]').click();
    await flush();
    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j/sub");
  });

  it("typing a directory path and pressing Enter navigates there", async () => {
    await setup();
    await browse();

    const path = q<HTMLInputElement>(".sftp-path");
    path.value = "/var/log";
    path.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flush();

    expect(sftpRealpath).toHaveBeenCalledWith("a", "/var/log");
    expect(sftpList).toHaveBeenLastCalledWith("a", "/var/log");
    expect(q<HTMLInputElement>(".sftp-path").value).toBe("/var/log");
  });

  it("typing a file path navigates to its parent folder", async () => {
    await setup();
    await browse();

    vi.mocked(sftpList).mockRejectedValueOnce(new Error("not a directory"));

    const path = q<HTMLInputElement>(".sftp-path");
    path.value = "/etc/hosts";
    path.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flush();

    expect(sftpList).toHaveBeenLastCalledWith("a", "/etc");
    expect(q<HTMLInputElement>(".sftp-path").value).toBe("/etc");
  });

  it("Back is disabled at the start of history and Forward at the end", async () => {
    await setup();
    await browse(); // home only → both ends

    const back = q<HTMLButtonElement>('.sftp-panel [data-action="back"]');
    const forward = q<HTMLButtonElement>('.sftp-panel [data-action="forward"]');
    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);

    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")
      ?.click();
    await flush();
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);

    back.click();
    await flush();
    expect(forward.disabled).toBe(false);
  });

  it("a click landing on a toolbar button's SVG icon still navigates", async () => {
    await setup();
    await browse();
    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")
      ?.click();
    await flush(); // at /home/j/sub, Back enabled

    const backSvg = document.querySelector('.sftp-panel [data-action="back"] svg');
    expect(backSvg).not.toBeNull();
    backSvg?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(sftpList).toHaveBeenLastCalledWith("a", "/home/j");
  });

  it("a progress event updates the bar width and percentage", async () => {
    await setup();
    await browse();

    h.progressHandler?.({
      deviceId: "a",
      direction: "download",
      transferred: 50,
      total: 100,
    });

    const row = q(".sftp-progress");
    expect(row.classList.contains("active")).toBe(true);
    expect(q<HTMLElement>(".sftp-progress-fill").style.width).toBe("50%");
    expect(q(".sftp-progress-pct").textContent).toBe("50%");
  });

  it("ignores progress events for a different device", async () => {
    await setup();
    await browse();

    h.progressHandler?.({
      deviceId: "other",
      direction: "download",
      transferred: 50,
      total: 100,
    });
    expect(q(".sftp-progress").classList.contains("active")).toBe(false);
  });

  it("a completed download collapses to a checkmark, then auto-hides", async () => {
    vi.useFakeTimers();
    try {
      h.saveResult = "C:/local/readme.txt";
      await setup();
      await browse();
      document
        .querySelector<HTMLButtonElement>(".sftp-entry.is-file .sftp-entry-name")
        ?.click();
      await flush(); // download resolves → completeProgress

      const row = q(".sftp-progress");
      expect(row.classList.contains("done")).toBe(true);
      expect(q(".sftp-progress-pct").textContent).toBe("Done");

      vi.advanceTimersByTime(2600);
      expect(row.classList.contains("active")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking cancel during a transfer requests cancellation", async () => {
    await setup();
    await browse();
    h.progressHandler?.({
      deviceId: "a",
      direction: "upload",
      transferred: 10,
      total: 100,
    });

    q<HTMLButtonElement>(".sftp-progress-cancel").click();
    await flush();
    expect(sftpCancelTransfer).toHaveBeenCalledWith("a");
  });

  it("a cancelled download is reported quietly (status, no error toast)", async () => {
    vi.mocked(sftpDownload).mockRejectedValueOnce({
      code: "Cancelled",
      message: "transfer cancelled",
    } satisfies AppError);
    const onError = vi.fn();
    h.saveResult = "C:/local/readme.txt";

    await setup({ onError });
    await browse();
    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-file .sftp-entry-name")
      ?.click();
    await flush();

    expect(onError).not.toHaveBeenCalled();
    expect(q(".sftp-status").textContent).toBe("Transfer cancelled");
    expect(q(".sftp-progress").classList.contains("active")).toBe(false);
  });

  it("toggles the row hover class on mouse enter/leave and clears it on download", async () => {
    h.saveResult = null; // cancel the dialog so nothing else happens
    await setup();
    await browse();

    const row = q(".sftp-entry.is-file");
    row.dispatchEvent(new MouseEvent("mouseenter"));
    expect(row.classList.contains("hovering")).toBe(true);
    row.dispatchEvent(new MouseEvent("mouseleave"));
    expect(row.classList.contains("hovering")).toBe(false);

    // Opening the (native) download dialog clears any lingering hover so the
    // action buttons don't stay stuck visible.
    row.dispatchEvent(new MouseEvent("mouseenter"));
    q<HTMLButtonElement>(".sftp-entry.is-file .sftp-entry-name").click();
    await flush();
    expect(row.classList.contains("hovering")).toBe(false);
  });

  /* ----- panel lifecycle ------------------------------------------------- */

  it("hiding the panel (×) disconnects and hides it", async () => {
    await setup();
    await browse();

    q<HTMLButtonElement>('.sftp-panel [data-action="hide"]').click();
    await flush();

    expect(sftpDisconnect).toHaveBeenCalledWith("a");
    expect(q(".sftp-panel").hidden).toBe(true);
    expect(q("#sftp-btn").getAttribute("aria-pressed")).toBe("false");
  });

  it("toggle() hides+disconnects an open panel (header button behavior)", async () => {
    const panel = await setup();
    await browse();
    expect(q(".sftp-panel").hidden).toBe(false);

    panel.toggle(); // → hide
    await flush();
    expect(sftpDisconnect).toHaveBeenCalledWith("a");
    expect(q(".sftp-panel").hidden).toBe(true);
  });

  it("collapsing keeps the connection (no disconnect); expanding restores it", async () => {
    await setup();
    await browse();

    q<HTMLButtonElement>('.sftp-panel [data-action="collapse"]').click();
    await flush();
    expect(q(".sftp-panel").classList.contains("sftp-collapsed")).toBe(true);
    expect(q(".sftp-splitter").hidden).toBe(true);
    // Inline width is cleared so the collapsed-rail CSS width can apply.
    expect(q(".sftp-panel").style.width).toBe("");
    expect(sftpDisconnect).not.toHaveBeenCalled();

    q<HTMLButtonElement>('.sftp-panel [data-action="expand"]').click();
    await flush();
    expect(q(".sftp-panel").classList.contains("sftp-collapsed")).toBe(false);
    expect(q(".sftp-panel").style.width).not.toBe("");
  });

  it("switching devices disconnects the previous one", async () => {
    h.devices = [sshDevice("a", "Alpha"), sshDevice("b", "Beta")];
    await setup();
    await browse(); // connected to "a"

    const select = q<HTMLSelectElement>(".sftp-device-select");
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    expect(sftpDisconnect).toHaveBeenCalledWith("a");
    expect(sftpConnect).toHaveBeenLastCalledWith("b");
  });

  it("the toggle disconnects (red→green) but keeps the panel open", async () => {
    await setup();
    await browse();

    const toggle = q<HTMLButtonElement>('.sftp-panel [data-action="conn-toggle"]');
    expect(toggle.classList.contains("is-connected")).toBe(true);

    toggle.click();
    await flush();

    expect(sftpDisconnect).toHaveBeenCalledWith("a");
    expect(q(".sftp-panel").hidden).toBe(false);
    // Toggle flips to the green "connect" state; no separate Reconnect button.
    expect(toggle.classList.contains("is-disconnected")).toBe(true);
    expect(document.querySelector('[data-action="reconnect"]')).toBeNull();
  });

  it("the green toggle reconnects the last device after a disconnect", async () => {
    await setup();
    await browse();
    const toggle = q<HTMLButtonElement>('.sftp-panel [data-action="conn-toggle"]');
    toggle.click(); // disconnect
    await flush();
    vi.mocked(sftpConnect).mockClear();

    toggle.click(); // reconnect
    await flush();
    expect(sftpConnect).toHaveBeenCalledWith("a");
  });

  it("the toggle is disabled when disconnected with no device selected", async () => {
    const panel = await setup();
    panel.open();
    await flush();
    const toggle = q<HTMLButtonElement>('.sftp-panel [data-action="conn-toggle"]');
    expect(toggle.classList.contains("is-disconnected")).toBe(true);
    expect(toggle.disabled).toBe(true);
  });

  it("an idle collapsed panel auto-disconnects after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      await setup({ getIdleDisconnectMins: () => 5 });
      await browse();

      q<HTMLButtonElement>('.sftp-panel [data-action="collapse"]').click();
      await flush();
      expect(sftpDisconnect).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5 * 60_000 + 100);
      await flush();
      expect(sftpDisconnect).toHaveBeenCalledWith("a");
    } finally {
      vi.useRealTimers();
    }
  });

  /* ----- persistence ----------------------------------------------------- */

  it("layoutState is undefined until the panel is opened, then reflects it", async () => {
    const panel = await setup();
    expect(panel.layoutState()).toBeUndefined();

    await browse(); // opens + connects "a"
    const s = panel.layoutState();
    expect(s).toEqual({ open: true, collapsed: false, width: 360, deviceId: "a" });
  });

  it("onPersist fires on open, collapse and hide", async () => {
    const onPersist = vi.fn();
    const panel = await setup({ onPersist });
    panel.toggle(); // open
    await flush();
    q<HTMLButtonElement>('.sftp-panel [data-action="collapse"]').click();
    await flush();
    panel.toggle(); // hide
    await flush();
    expect(onPersist).toHaveBeenCalledTimes(3);
  });

  it("restores open + collapsed + width + preselected device without reconnecting", async () => {
    const panel = await setup({
      initialState: { open: true, collapsed: true, width: 500, deviceId: "a" },
    });
    expect(sftpConnect).not.toHaveBeenCalled(); // never auto-reconnects
    expect(q(".sftp-panel").hidden).toBe(false);
    expect(q(".sftp-panel").classList.contains("sftp-collapsed")).toBe(true);
    expect(q<HTMLSelectElement>(".sftp-device-select").value).toBe("a");
    // Width is remembered (applied once expanded).
    expect(panel.layoutState()?.width).toBe(500);
  });

  it("drops a restored device id that no longer exists", async () => {
    const panel = await setup({
      initialState: { open: true, collapsed: false, width: 360, deviceId: "gone" },
    });
    expect(q<HTMLSelectElement>(".sftp-device-select").value).toBe("");
    expect(panel.layoutState()?.deviceId).toBeNull();
  });

  it("clamps a restored width below the minimum", async () => {
    const panel = await setup({
      initialState: { open: true, collapsed: false, width: 10, deviceId: null },
    });
    expect(panel.layoutState()?.width).toBe(260);
  });

  it("a zero idle timeout never auto-disconnects", async () => {
    vi.useFakeTimers();
    try {
      await setup({ getIdleDisconnectMins: () => 0 });
      await browse();
      q<HTMLButtonElement>('.sftp-panel [data-action="collapse"]').click();
      await flush();

      vi.advanceTimersByTime(60 * 60_000);
      await flush();
      expect(sftpDisconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
