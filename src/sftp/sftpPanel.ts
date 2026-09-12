/**
 * The Files (SFTP) feature: a sidebar card under Tunnels listing every SSH
 * device with a "Browse" button, plus a standalone browser drawer that opens
 * over the app for the chosen device. Intentionally separate from the terminal
 * grid — an SFTP browse has no terminal — mirroring how the Tunnels card is its
 * own thing.
 *
 * The drawer connects on open (reusing the shell connect + host-key path in the
 * backend), lists the server's home directory, and lets the user navigate,
 * download, upload, make/rename/delete entries. Closing the drawer disconnects,
 * so an idle SSH connection is never left open.
 *
 * Remote paths are POSIX; see `sftpFormat.ts` for the path/size/time helpers.
 */

import {
  listDevices,
  sftpConnect,
  sftpDisconnect,
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpRealpath,
  sftpRemove,
  sftpRename,
  sftpUpload,
  sftpCancelTransfer,
  onSftpProgress,
  type AppError,
  type Device,
  type SftpEntry,
  type SftpProgressEvent,
  type SshDevice,
} from "../ipc";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  pickDownloadSavePath,
  pickUploadOpenPath,
} from "../ui/fileDialog";
import { confirm, prompt } from "../ui/confirm";
import {
  trashIcon,
  pencilIcon,
  arrowUpIcon,
  arrowLeftIcon,
  arrowRightIcon,
  reloadIcon,
  uploadIcon,
  downloadIcon,
  folderPlusIcon,
} from "../ui/icons";
import { joinRemote, parentOf, formatSize, formatMtime } from "./sftpFormat";
import { basename } from "@tauri-apps/api/path";

export interface SftpPanelOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
}

/** The SSH devices — the only ones that can be browsed over SFTP. */
export function browsableDevices(devices: Device[]): SshDevice[] {
  return devices.filter((d): d is SshDevice => d.kind === "ssh");
}

export class SftpPanel {
  private devices: Device[] = [];
  private readonly container: HTMLElement | null;
  private cardBody: HTMLElement | null = null;

  /** The browser drawer (built once, shown/hidden). */
  private drawer: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private pathEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressIconEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;
  private progressPctEl: HTMLElement | null = null;

  /** `sftp_progress` event subscription (live while the drawer exists). */
  private unlistenProgress: UnlistenFn | null = null;
  /** Timer that hides the completed-progress row after a short delay. */
  private progressHideTimer: ReturnType<typeof setTimeout> | null = null;

  /** The device whose connection the drawer is currently showing. */
  private activeDeviceId: string | null = null;
  /** The directory currently listed. */
  private cwd = "/";
  /**
   * Visited-directory stack for Back/Forward, oldest first. `historyIndex` points
   * at the current directory within it; going Back/Forward moves the index without
   * pushing, while a fresh navigation truncates any forward entries (browser
   * semantics). Reset on each `openFor`.
   */
  private history: string[] = [];
  private historyIndex = -1;
  /** True while a connect/list/transfer is in flight (disables the toolbar). */
  private busy = false;

  constructor(private readonly options: SftpPanelOptions = {}) {
    this.container = document.querySelector<HTMLElement>(".sftp-list");
  }

  async init(): Promise<void> {
    this.buildCard();
    this.buildDrawer();
    this.devices = await this.safeListDevices();
    this.render();
  }

  /** Re-fetch devices and re-render the card (device CRUD happened). */
  async refresh(): Promise<void> {
    this.devices = await this.safeListDevices();
    this.render();
  }

  /** Stop listening for progress events — used by tests; the app keeps the panel
   * for its lifetime. */
  dispose(): void {
    this.unlistenProgress?.();
    this.unlistenProgress = null;
    this.clearHideTimer();
  }

  private async safeListDevices(): Promise<Device[]> {
    try {
      return await listDevices();
    } catch (err) {
      this.options.onError?.(err as AppError);
      return [];
    }
  }

  /* ----- sidebar card ----------------------------------------------------- */

  private buildCard(): void {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="sftp-manager">
        <div class="device-list-header">
          <h2>Files</h2>
        </div>
        <div class="sftp-list-items"></div>
      </div>
    `;
    this.cardBody = this.container.querySelector<HTMLElement>(".sftp-list-items");
  }

  private render(): void {
    if (!this.cardBody) return;
    this.cardBody.replaceChildren();

    const devices = browsableDevices(this.devices);
    if (devices.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sftp-empty";
      empty.textContent = "No SSH device to browse. Add one under Devices.";
      this.cardBody.appendChild(empty);
      return;
    }
    for (const device of devices) {
      const row = document.createElement("div");
      row.className = "sftp-device-row";

      const name = document.createElement("span");
      name.className = "sftp-device-name";
      name.textContent = device.name;

      const browse = document.createElement("button");
      browse.type = "button";
      browse.className = "btn btn-primary btn-small";
      browse.textContent = "Browse";
      browse.addEventListener("click", () => void this.openFor(device.id));

      row.append(name, browse);
      this.cardBody.appendChild(row);
    }
  }

  /* ----- drawer shell ----------------------------------------------------- */

  private buildDrawer(): void {
    // Appended to <body> so the overlay covers the whole app, like the shared
    // confirm/prompt modals.
    const drawer = document.createElement("div");
    drawer.className = "dialog sftp-drawer dialog-hidden";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-hidden", "true");
    drawer.innerHTML = `
      <div class="dialog-overlay" data-action="close"></div>
      <div class="dialog-content sftp-content">
        <div class="dialog-header">
          <h2 class="sftp-title">Files</h2>
          <button type="button" class="dialog-close-btn" data-action="close" aria-label="Close">&times;</button>
        </div>
        <div class="sftp-toolbar">
          <code class="sftp-path" aria-label="Current directory"></code>
          <div class="sftp-toolbar-actions">
            <button type="button" class="btn btn-icon" data-action="back" title="Previous folder" aria-label="Previous folder">${arrowLeftIcon}</button>
            <button type="button" class="btn btn-icon" data-action="forward" title="Next folder" aria-label="Next folder">${arrowRightIcon}</button>
            <button type="button" class="btn btn-icon" data-action="up" title="Parent directory" aria-label="Parent directory">${arrowUpIcon}</button>
            <button type="button" class="btn btn-icon" data-action="refresh" title="Refresh" aria-label="Refresh">${reloadIcon}</button>
            <button type="button" class="btn btn-icon" data-action="upload" title="Upload a file here" aria-label="Upload a file here">${uploadIcon}</button>
            <button type="button" class="btn btn-icon" data-action="mkdir" title="Create a folder" aria-label="Create a folder">${folderPlusIcon}</button>
          </div>
        </div>
        <div class="sftp-entries" role="list"></div>
        <div class="sftp-progress" role="status" aria-live="polite">
          <span class="sftp-progress-icon" aria-hidden="true"></span>
          <div class="sftp-progress-track"><div class="sftp-progress-fill"></div></div>
          <span class="sftp-progress-pct"></span>
          <button type="button" class="btn btn-icon sftp-progress-cancel" data-action="cancel-transfer" title="Cancel transfer" aria-label="Cancel transfer">&times;</button>
        </div>
        <div class="sftp-status" aria-live="polite"></div>
      </div>
    `;
    document.body.appendChild(drawer);

    this.drawer = drawer;
    this.titleEl = drawer.querySelector(".sftp-title");
    this.pathEl = drawer.querySelector(".sftp-path");
    this.listEl = drawer.querySelector(".sftp-entries");
    this.statusEl = drawer.querySelector(".sftp-status");
    this.progressEl = drawer.querySelector(".sftp-progress");
    this.progressIconEl = drawer.querySelector(".sftp-progress-icon");
    this.progressFillEl = drawer.querySelector(".sftp-progress-fill");
    this.progressPctEl = drawer.querySelector(".sftp-progress-pct");

    // Live transfer progress (throttled events from the backend).
    void onSftpProgress((e) => this.onProgress(e)).then((un) => {
      this.unlistenProgress = un;
    });

    drawer.addEventListener("click", (e) => {
      const target = e.target;
      // Use `Element`, not `HTMLElement`: a click landing on a button's inline
      // SVG icon has an `SVGElement` target, which is an `Element` but not an
      // `HTMLElement` — guarding on `HTMLElement` silently dropped icon clicks.
      // `closest` still resolves to the enclosing `[data-action]` button.
      if (!(target instanceof Element)) return;
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      switch (action) {
        case "close":
          void this.close();
          break;
        case "back":
          if (!this.busy) void this.goBack();
          break;
        case "forward":
          if (!this.busy) void this.goForward();
          break;
        case "up":
          if (!this.busy) void this.goUp();
          break;
        case "refresh":
          if (!this.busy) void this.loadDir(this.cwd);
          break;
        case "upload":
          if (!this.busy) void this.handleUpload();
          break;
        case "mkdir":
          if (!this.busy) void this.handleMkdir();
          break;
        case "cancel-transfer":
          void this.handleCancelTransfer();
          break;
      }
    });
    drawer.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") void this.close();
    });
  }

  /* ----- connection lifecycle -------------------------------------------- */

  private async openFor(deviceId: string): Promise<void> {
    const device = this.devices.find((d) => d.id === deviceId);
    this.activeDeviceId = deviceId;
    this.history = [];
    this.historyIndex = -1;
    this.showDrawer(true);
    if (this.titleEl) this.titleEl.textContent = `Files — ${device?.name ?? "device"}`;
    this.setStatus("Connecting…");
    this.setBusy(true);
    try {
      // A first-contact host key raises the global host-key dialog; on accept
      // the connect proceeds and resolves here.
      const startDir = await sftpConnect(deviceId);
      await this.goTo(startDir);
    } catch (err) {
      this.setStatus("");
      this.options.onError?.(err as AppError);
      await this.close();
    } finally {
      this.setBusy(false);
    }
  }

  /** Hide the drawer and disconnect the active connection (idempotent). */
  private async close(): Promise<void> {
    this.showDrawer(false);
    this.hideProgress();
    const deviceId = this.activeDeviceId;
    this.activeDeviceId = null;
    if (this.listEl) this.listEl.replaceChildren();
    if (deviceId) {
      try {
        await sftpDisconnect(deviceId);
      } catch {
        // Best-effort — the connection is torn down backend-side regardless.
      }
    }
  }

  /* ----- navigation + operations ----------------------------------------- */

  /**
   * List `path` and render it as the current directory. Does NOT touch the
   * Back/Forward history — used for Refresh, post-operation re-listing, and as
   * the shared worker behind `goTo`/`goBack`/`goForward`.
   */
  private async loadDir(path: string): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.setBusy(true);
    try {
      const entries = await sftpList(this.activeDeviceId, path);
      this.cwd = path;
      if (this.pathEl) this.pathEl.textContent = path;
      this.renderEntries(entries);
      this.setStatus(
        entries.length === 1 ? "1 item" : `${entries.length} items`,
      );
    } catch (err) {
      this.options.onError?.(err as AppError);
    } finally {
      this.setBusy(false); // also reconciles Back/Forward enabled state
    }
  }

  /**
   * Navigate to a new directory, recording it in history: truncate any forward
   * entries and push, then load it. Navigating to the directory already current
   * (e.g. a redundant click) only re-lists it.
   */
  private async goTo(path: string): Promise<void> {
    if (path === this.history[this.historyIndex]) {
      await this.loadDir(path);
      return;
    }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(path);
    this.historyIndex = this.history.length - 1;
    await this.loadDir(path);
  }

  /** Step back to the previous directory in history (no-op at the start). */
  private async goBack(): Promise<void> {
    if (this.historyIndex <= 0) return;
    const target = this.history[this.historyIndex - 1];
    if (target === undefined) return;
    this.historyIndex -= 1;
    await this.loadDir(target);
  }

  /** Step forward to the next directory in history (no-op at the end). */
  private async goForward(): Promise<void> {
    if (this.historyIndex >= this.history.length - 1) return;
    const target = this.history[this.historyIndex + 1];
    if (target === undefined) return;
    this.historyIndex += 1;
    await this.loadDir(target);
  }

  private async goUp(): Promise<void> {
    if (this.activeDeviceId === null) return;
    try {
      // Resolve `<cwd>/..` server-side so symlinked paths go to the real parent.
      const parent = await sftpRealpath(this.activeDeviceId, parentOf(this.cwd));
      if (parent !== this.cwd) await this.goTo(parent);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async handleDownload(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    const local = await pickDownloadSavePath(entry.name);
    if (local === null) return; // cancelled
    const remote = joinRemote(this.cwd, entry.name);
    this.setBusy(true);
    this.setStatus(`Downloading ${entry.name}…`);
    this.startProgress("download");
    try {
      const bytes = await sftpDownload(this.activeDeviceId, remote, local);
      this.completeProgress();
      this.setStatus(`${entry.name} downloaded (${formatSize(bytes)})`);
      this.options.onSuccess?.(`Downloaded ${entry.name}`);
    } catch (err) {
      this.handleTransferError(err as AppError);
    } finally {
      this.setBusy(false);
    }
  }

  private async handleUpload(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const local = await pickUploadOpenPath();
    if (local === null) return; // cancelled
    const name = await basename(local);
    const remote = joinRemote(this.cwd, name);
    this.setBusy(true);
    this.setStatus(`Uploading ${name}…`);
    this.startProgress("upload");
    try {
      await sftpUpload(this.activeDeviceId, local, remote);
      this.completeProgress();
      this.options.onSuccess?.(`Uploaded ${name}`);
      await this.loadDir(this.cwd); // reflect the new file
    } catch (err) {
      this.handleTransferError(err as AppError);
      this.setBusy(false);
    }
  }

  /**
   * Shared error handling for a transfer: a user cancellation
   * (`code === "Cancelled"`) is quiet — just a status line, no error toast —
   * while a real failure surfaces through `onError`. Either way the progress
   * bar is hidden.
   */
  private handleTransferError(error: AppError): void {
    this.hideProgress();
    if (error.code === "Cancelled") {
      this.setStatus("Transfer cancelled");
    } else {
      this.setStatus("");
      this.options.onError?.(error);
    }
  }

  private async handleCancelTransfer(): Promise<void> {
    if (this.activeDeviceId === null) return;
    this.setStatus("Cancelling…");
    try {
      await sftpCancelTransfer(this.activeDeviceId);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async handleMkdir(): Promise<void> {
    if (this.activeDeviceId === null) return;
    const name = await prompt("New folder", "Folder name");
    if (name === null || name.trim() === "") return;
    try {
      await sftpMkdir(this.activeDeviceId, joinRemote(this.cwd, name.trim()));
      await this.loadDir(this.cwd);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async handleRename(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    const next = await prompt("Rename", "New name", entry.name);
    if (next === null || next.trim() === "" || next.trim() === entry.name) return;
    try {
      await sftpRename(
        this.activeDeviceId,
        joinRemote(this.cwd, entry.name),
        joinRemote(this.cwd, next.trim()),
      );
      await this.loadDir(this.cwd);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async handleDelete(entry: SftpEntry): Promise<void> {
    if (this.activeDeviceId === null) return;
    const isDir = entry.kind === "dir";
    const confirmed = await confirm(
      `Delete "${entry.name}"?${isDir ? " The folder must be empty." : ""} This cannot be undone.`,
      { title: "Delete?", confirmLabel: "Delete", danger: true },
    );
    if (!confirmed) return;
    try {
      await sftpRemove(this.activeDeviceId, joinRemote(this.cwd, entry.name), isDir);
      await this.loadDir(this.cwd);
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /* ----- entry rendering -------------------------------------------------- */

  private renderEntries(entries: SftpEntry[]): void {
    if (!this.listEl) return;
    this.listEl.replaceChildren();

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sftp-empty";
      empty.textContent = "Empty directory.";
      this.listEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      this.listEl.appendChild(this.renderEntryRow(entry));
    }
  }

  private renderEntryRow(entry: SftpEntry): HTMLElement {
    const isDir = entry.kind === "dir";
    const row = document.createElement("div");
    row.className = `sftp-entry is-${entry.kind}`;
    row.setAttribute("role", "listitem");

    const icon = document.createElement("span");
    icon.className = "sftp-entry-icon";
    icon.textContent = isDir ? "📁" : entry.kind === "symlink" ? "🔗" : "📄";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "sftp-entry-name";
    name.textContent = entry.name;
    name.title = isDir ? "Open folder" : "Download file";
    // A directory descends; a file/symlink downloads (double-click parity with
    // a desktop file manager, but a single click is enough here for reachability).
    name.addEventListener("click", () => {
      if (this.busy) return;
      if (isDir) void this.goTo(joinRemote(this.cwd, entry.name));
      else void this.handleDownload(entry);
    });

    const meta = document.createElement("span");
    meta.className = "sftp-entry-meta";
    const size = isDir ? "" : formatSize(entry.size);
    const time = formatMtime(entry.modified);
    meta.textContent = [size, time].filter(Boolean).join("  ·  ");

    const actions = document.createElement("span");
    actions.className = "sftp-entry-actions";
    if (!isDir) {
      actions.appendChild(
        this.iconButton(downloadIcon, "Download", () => void this.handleDownload(entry)),
      );
    }
    actions.appendChild(
      this.iconButton(pencilIcon, "Rename", () => void this.handleRename(entry)),
    );
    actions.appendChild(
      this.iconButton(trashIcon, "Delete", () => void this.handleDelete(entry), true),
    );

    row.append(icon, name, meta, actions);
    return row;
  }

  private iconButton(
    html: string,
    label: string,
    onClick: () => void,
    danger = false,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn btn-icon btn-small${danger ? " btn-danger" : ""}`;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = html;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.busy) onClick();
    });
    return btn;
  }

  /* ----- small view helpers ---------------------------------------------- */

  private showDrawer(show: boolean): void {
    if (!this.drawer) return;
    this.drawer.classList.toggle("dialog-hidden", !show);
    this.drawer.setAttribute("aria-hidden", show ? "false" : "true");
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.drawer
      ?.querySelectorAll<HTMLButtonElement>(".sftp-toolbar .btn")
      .forEach((b) => {
        b.disabled = busy;
      });
    // While idle, Back/Forward reflect where we are in history rather than being
    // blanket-enabled (setBusy(false) just re-enabled the whole toolbar).
    if (!busy) this.updateNavButtons();
  }

  /** Enable/disable Back and Forward per the history cursor (idle state only). */
  private updateNavButtons(): void {
    const back = this.drawer?.querySelector<HTMLButtonElement>('[data-action="back"]');
    const forward = this.drawer?.querySelector<HTMLButtonElement>('[data-action="forward"]');
    if (back) back.disabled = this.historyIndex <= 0;
    if (forward) forward.disabled = this.historyIndex >= this.history.length - 1;
  }

  /* ----- transfer progress ----------------------------------------------- */

  /** Show the progress row at 0 % for a starting transfer. */
  private startProgress(direction: "download" | "upload"): void {
    if (!this.progressEl) return;
    this.clearHideTimer();
    this.progressEl.classList.remove("done");
    this.progressEl.classList.add("active");
    this.setProgressIcon(direction);
    this.setFill(0);
    if (this.progressPctEl) this.progressPctEl.textContent = "0%";
  }

  /** Update the bar from a throttled `sftp_progress` event for the active device. */
  private onProgress(e: SftpProgressEvent): void {
    if (e.deviceId !== this.activeDeviceId || !this.progressEl) return;
    this.clearHideTimer();
    this.progressEl.classList.remove("done");
    this.progressEl.classList.add("active");
    this.setProgressIcon(e.direction);
    const pct =
      e.total > 0 ? Math.min(100, Math.round((e.transferred / e.total) * 100)) : 0;
    this.setFill(pct);
    if (this.progressPctEl) {
      this.progressPctEl.textContent =
        e.total > 0 ? `${pct}%` : formatSize(e.transferred);
    }
  }

  /** Collapse the bar to a checkmark on completion, then auto-hide after ~2.5 s. */
  private completeProgress(): void {
    if (!this.progressEl) return;
    this.clearHideTimer();
    this.setFill(100);
    this.progressEl.classList.add("active", "done");
    if (this.progressIconEl) this.progressIconEl.textContent = "✓";
    if (this.progressPctEl) this.progressPctEl.textContent = "Done";
    this.progressHideTimer = setTimeout(() => this.hideProgress(), 2500);
  }

  private hideProgress(): void {
    this.clearHideTimer();
    this.progressEl?.classList.remove("active", "done");
  }

  private clearHideTimer(): void {
    if (this.progressHideTimer !== null) {
      clearTimeout(this.progressHideTimer);
      this.progressHideTimer = null;
    }
  }

  private setFill(pct: number): void {
    if (this.progressFillEl) this.progressFillEl.style.width = `${pct}%`;
  }

  private setProgressIcon(direction: "download" | "upload"): void {
    if (this.progressIconEl) {
      this.progressIconEl.innerHTML =
        direction === "upload" ? uploadIcon : downloadIcon;
    }
  }
}

/** Constructs and initializes the Files (SFTP) panel. */
export function initSftpPanel(options: SftpPanelOptions = {}): SftpPanel {
  const panel = new SftpPanel(options);
  void panel.init();
  return panel;
}
