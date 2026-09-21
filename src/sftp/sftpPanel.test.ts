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
  dirResult: null as string | null,
  uploadDirResult: null as string | null,
  localExists: false,
  remoteExists: false,
  conflictChoice: "overwrite" as "overwrite" | "skip" | "rename" | null,
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
  sftpDownloadDir: vi.fn(async () => {}),
  sftpUploadDir: vi.fn(async () => {}),
  sftpLocalExists: vi.fn(async () => h.localExists),
  sftpExists: vi.fn(async () => h.remoteExists),
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
  pickDownloadDirPath: vi.fn(async () => h.dirResult),
  pickUploadDirPath: vi.fn(async () => h.uploadDirResult),
}));

vi.mock("../ui/confirm", () => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => "newname"),
  chooseConflict: vi.fn(async () => h.conflictChoice),
}));

vi.mock("@tauri-apps/api/path", () => ({
  basename: vi.fn(async (p: string) => p.split(/[\\/]/).pop() ?? p),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

import { SftpPanel, browsableDevices, type SftpPanelOptions } from "./sftpPanel";
import {
  sftpConnect,
  sftpList,
  sftpRealpath,
  sftpDisconnect,
  sftpDownload,
  sftpDownloadDir,
  sftpUploadDir,
  sftpRemove,
  sftpRename,
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
  // Enough to drain the transfer queue draining several items back-to-back
  // (each item completes, then the worker starts the next on a microtask).
  for (let i = 0; i < 15; i++) await Promise.resolve();
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
    h.dirResult = null;
    h.uploadDirResult = null;
    h.localExists = false;
    h.remoteExists = false;
    h.conflictChoice = "overwrite";
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

  /** Start a file download whose backend call stays pending, so its queue item
   * sits in the `active` state. Returns the resolver to finish it. */
  async function startPendingDownload(): Promise<(bytes: number) => void> {
    let resolve!: (bytes: number) => void;
    vi.mocked(sftpDownload).mockReturnValueOnce(
      new Promise<number>((res) => {
        resolve = res;
      }),
    );
    h.saveResult = "C:/local/readme.txt";
    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-file .sftp-entry-name")
      ?.click();
    await flush(); // enqueued → active, run pending
    return resolve;
  }

  it("a progress event updates the active item's bar and percentage", async () => {
    await setup();
    await browse();
    const finish = await startPendingDownload();

    const rowBefore = q(".sftp-queue-item");
    h.progressHandler?.({ deviceId: "a", direction: "download", transferred: 50, total: 100 });

    expect(q(".sftp-queue").hidden).toBe(false);
    expect(q<HTMLElement>(".sftp-queue-fill").style.width).toBe("50%");
    expect(q(".sftp-queue-pct").textContent).toBe("50%");
    // Updated in place — the row node is NOT rebuilt on a progress tick (so a
    // rapid tick can't swallow a cancel click or re-announce the aria-live row).
    expect(q(".sftp-queue-item")).toBe(rowBefore);
    finish(123);
    await flush();
  });

  it("ignores progress events for a different device", async () => {
    await setup();
    await browse();
    const finish = await startPendingDownload();

    h.progressHandler?.({ deviceId: "other", direction: "download", transferred: 50, total: 100 });
    expect(q<HTMLElement>(".sftp-queue-fill").style.width).toBe("0%");
    finish(123);
    await flush();
  });

  it("a completed download shows Done, then auto-removes its row", async () => {
    vi.useFakeTimers();
    try {
      h.saveResult = "C:/local/readme.txt";
      await setup();
      await browse();
      document
        .querySelector<HTMLButtonElement>(".sftp-entry.is-file .sftp-entry-name")
        ?.click();
      await flush(); // download resolves → done

      const item = q(".sftp-queue-item");
      expect(item.classList.contains("is-done")).toBe(true);
      expect(q(".sftp-queue-detail").textContent).toContain("Done");

      vi.advanceTimersByTime(3100);
      expect(document.querySelector(".sftp-queue-item")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking cancel on an active transfer requests cancellation", async () => {
    await setup();
    await browse();
    const finish = await startPendingDownload();

    q<HTMLButtonElement>(".sftp-queue-cancel").click();
    await flush();
    expect(sftpCancelTransfer).toHaveBeenCalledWith("a");
    finish(123);
    await flush();
  });

  it("a cancelled download is shown quietly in the queue (no error toast)", async () => {
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
    const item = q(".sftp-queue-item");
    expect(item.classList.contains("is-cancelled")).toBe(true);
    expect(q(".sftp-queue-detail").textContent).toBe("Transfer cancelled");
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

  /* ----- multi-select + bulk operations ---------------------------------- */

  function checks(): HTMLInputElement[] {
    return [...document.querySelectorAll<HTMLInputElement>(".sftp-entry-check")];
  }
  function check(i: number): HTMLInputElement {
    const el = checks()[i];
    if (!el) throw new Error(`missing checkbox ${i}`);
    return el;
  }

  it("selecting rows updates the bulk-bar count; select-all toggles everything", async () => {
    await setup();
    await browse(); // entries: [sub (dir), readme.txt (file)]

    check(1).click();
    expect(q(".sftp-sel-count").textContent).toBe("1 selected");

    q<HTMLButtonElement>('[data-action="select-all"]').click();
    expect(q(".sftp-sel-count").textContent).toBe("2 selected");
    expect(checks().every((c) => c.checked)).toBe(true);

    q<HTMLButtonElement>('[data-action="select-all"]').click();
    expect(checks().some((c) => c.checked)).toBe(false);
  });

  it("bulk delete removes each selected entry, recursively for folders", async () => {
    await setup();
    await browse();
    check(0).click(); // sub (dir)
    check(1).click(); // readme.txt (file)

    q<HTMLButtonElement>('[data-action="bulk-delete"]').click();
    await flush();

    expect(sftpRemove).toHaveBeenCalledWith("a", "/home/j/sub", true, true);
    expect(sftpRemove).toHaveBeenCalledWith("a", "/home/j/readme.txt", false, false);
  });

  it("bulk download fetches files directly and folders recursively into the chosen folder", async () => {
    h.dirResult = "C:/dest";
    await setup();
    await browse();
    check(0).click(); // sub (dir) — recursive download
    check(1).click(); // readme.txt (file)

    q<HTMLButtonElement>('[data-action="bulk-download"]').click();
    await flush();

    expect(sftpDownload).toHaveBeenCalledWith("a", "/home/j/readme.txt", "C:/dest/readme.txt");
    expect(sftpDownloadDir).toHaveBeenCalledWith("a", "/home/j/sub", "C:/dest/sub", "overwrite");
  });

  it("per-row folder download recurses into a chosen destination", async () => {
    h.dirResult = "C:/dest";
    await setup();
    await browse();

    // The folder row's download button (first action button on the dir row).
    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-actions .btn")
      ?.click();
    await flush();

    expect(sftpDownloadDir).toHaveBeenCalledWith("a", "/home/j/sub", "C:/dest/sub", "overwrite");
  });

  it("Upload folder recurses a local folder into the current directory", async () => {
    h.uploadDirResult = "C:/local/proj";
    await setup();
    await browse();

    q<HTMLButtonElement>('.sftp-panel [data-action="upload-dir"]').click();
    await flush();

    expect(sftpUploadDir).toHaveBeenCalledWith("a", "C:/local/proj", "/home/j/proj", "overwrite");
  });

  it("prompts for a conflict policy when the destination already exists", async () => {
    h.dirResult = "C:/dest";
    h.localExists = true; // target already present
    h.conflictChoice = "skip";
    await setup();
    await browse();

    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-actions .btn")
      ?.click();
    await flush();

    expect(sftpDownloadDir).toHaveBeenCalledWith("a", "/home/j/sub", "C:/dest/sub", "skip");
  });

  it("cancelling the conflict dialog aborts the transfer", async () => {
    h.dirResult = "C:/dest";
    h.localExists = true;
    h.conflictChoice = null; // user cancelled
    await setup();
    await browse();

    document
      .querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-actions .btn")
      ?.click();
    await flush();

    expect(sftpDownloadDir).not.toHaveBeenCalled();
  });

  it("cut then paste moves entries via server-side rename", async () => {
    await setup();
    await browse();
    check(1).click(); // readme.txt

    q<HTMLButtonElement>('[data-action="bulk-cut"]').click();
    await flush();
    // Paste is hidden in the source directory (a move there is a no-op).
    expect(q<HTMLButtonElement>(".sftp-bulk-paste").hidden).toBe(true);

    // The destination (sub) has a collision-free listing so the move proceeds.
    h.listResult = [{ name: "keep", kind: "dir", size: 0 }];
    document.querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")?.click();
    await flush();
    expect(q<HTMLButtonElement>(".sftp-bulk-paste").hidden).toBe(false);

    q<HTMLButtonElement>('[data-action="bulk-paste"]').click();
    await flush();
    expect(sftpRename).toHaveBeenCalledWith("a", "/home/j/readme.txt", "/home/j/sub/readme.txt");
  });

  it("paste refuses moving a folder into itself/a descendant", async () => {
    await setup();
    await browse();
    check(0).click(); // sub (dir)
    q<HTMLButtonElement>('[data-action="bulk-cut"]').click();
    await flush();

    // Navigate into the cut folder, then attempt to paste it into itself.
    document.querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")?.click();
    await flush();
    q<HTMLButtonElement>('[data-action="bulk-paste"]').click();
    await flush();

    expect(sftpRename).not.toHaveBeenCalled();
  });

  it("paste skips a name that already exists in the destination", async () => {
    await setup();
    await browse();
    check(1).click(); // readme.txt
    q<HTMLButtonElement>('[data-action="bulk-cut"]').click();
    await flush();

    // sub's listing still contains readme.txt (default mock) → collision → skip.
    document.querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")?.click();
    await flush();
    q<HTMLButtonElement>('[data-action="bulk-paste"]').click();
    await flush();

    expect(sftpRename).not.toHaveBeenCalled();
  });

  it("navigating clears the selection", async () => {
    await setup();
    await browse();
    check(1).click();
    expect(q(".sftp-sel-count").textContent).toBe("1 selected");

    document.querySelector<HTMLButtonElement>(".sftp-entry.is-dir .sftp-entry-name")?.click();
    await flush();
    expect(checks().some((c) => c.checked)).toBe(false);
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
