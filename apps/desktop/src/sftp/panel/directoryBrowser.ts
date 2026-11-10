/** The Files panel's current directory: listing it, the filter/sort view of
 * the listing, the path input, and Back/Forward/Up navigation. Remote paths
 * are POSIX. */

import { sftpList, sftpRealpath, type SftpEntry } from "../../ipc";
import { t, tp } from "../../i18n";
import { parentOf } from "../sftpFormat";
import type { DirHistory } from "./dirHistory";
import { DEFAULT_SORT, nextSort, viewEntries, type SortDir, type SortKey, type SortState } from "./entryView";
import type { EntryList } from "./entryList";
import type { PanelControls } from "./panelControls";
import type { PanelElements } from "./panelElements";
import type { PanelFeedback } from "./panelFeedback";
import type { PanelSession } from "./panelSession";

export interface BrowserDeps {
  els: () => PanelElements;
  session: PanelSession;
  controls: PanelControls;
  history: DirHistory;
  list: EntryList;
  feedback: PanelFeedback;
  /** A listing was shown (the bookmark star follows the directory). */
  onListed: () => void;
}

/** The connected device and the directory listed on it. */
export interface RemotePlace {
  deviceId: string;
  dir: string;
}

interface PathRequest {
  deviceId: string;
  input: string;
}

export class DirectoryBrowser {
  /** The directory currently listed. */
  private dir = "/";
  /** The full listing from the backend, before the filter/sort view. */
  private allEntries: SftpEntry[] = [];
  /** Active sort column + direction (folders always stay grouped on top). */
  private sort: SortState = DEFAULT_SORT;
  /** Live name filter for the current directory (cleared on navigation). */
  private filterText = "";

  constructor(private readonly deps: BrowserDeps) {}

  cwd(): string {
    return this.dir;
  }

  /** Where an operation on the current directory goes, or `null` when not connected. */
  place(): RemotePlace | null {
    const deviceId = this.deps.session.activeDeviceId;
    return deviceId === null ? null : { deviceId, dir: this.dir };
  }

  /** Whether `place` is still the listing on screen (no other device or
   * directory took over, e.g. while a dialog was open). */
  isAt(place: RemotePlace): boolean {
    return this.isShowing(place.deviceId, place.dir);
  }

  /** Whether `dir` on `deviceId` is the listing on screen. */
  isShowing(deviceId: string, dir: string): boolean {
    return this.deps.session.isConnectedTo(deviceId) && this.dir === dir;
  }

  /**
   * List `path` and render it as the current directory; `true` once it shows.
   * Does NOT touch the Back/Forward history — used for Refresh,
   * post-operation re-listing, and as the shared worker behind
   * `goTo`/`goBack`/`goForward`.
   */
  async loadDir(path: string): Promise<boolean> {
    const deviceId = this.deps.session.activeDeviceId;
    if (deviceId === null) return false;
    // Re-listing the same directory (Refresh, or an auto-refresh after a
    // transfer) keeps any live filter; navigating elsewhere starts fresh.
    const sameDir = path === this.dir;
    // A new listing invalidates the selection (names are directory-relative).
    this.deps.list.selection.clear();
    this.deps.controls.setBusy(true);
    try {
      return this.show(deviceId, path, sameDir, await sftpList(deviceId, path));
    } catch (err) {
      return this.failListing(deviceId, err);
    } finally {
      this.deps.controls.setBusy(false); // also reconciles Back/Forward enabled state
    }
  }

  /** Re-list the current directory. */
  reload(): Promise<boolean> {
    return this.loadDir(this.dir);
  }

  /** Re-list `dir` when it is still on screen and nothing else runs (a
   * transfer landed in it). */
  refreshIfShowing(deviceId: string, dir: string): void {
    if (!this.deps.controls.isBusy() && this.isShowing(deviceId, dir)) void this.loadDir(dir);
  }

  /**
   * Navigate to a new directory and, once it shows, record it in history
   * (dropping any forward entries). Navigating to the current directory only
   * re-lists it.
   */
  async goTo(path: string): Promise<void> {
    const isCurrent = this.deps.history.isCurrent(path);
    if (!(await this.loadDir(path)) || isCurrent) return;
    this.deps.history.record(path);
    this.deps.controls.updateNavButtons();
  }

  /** Step back to the previous directory in history (no-op at the start). */
  async goBack(): Promise<void> {
    const { history } = this.deps;
    await this.revisit(history.backTarget(), () => history.stepBack());
  }

  /** Step forward to the next directory in history (no-op at the end). */
  async goForward(): Promise<void> {
    const { history } = this.deps;
    await this.revisit(history.forwardTarget(), () => history.stepForward());
  }

  async goUp(): Promise<void> {
    const deviceId = this.deps.session.activeDeviceId;
    if (deviceId === null) return;
    await this.deps.feedback.attempt(() => this.goToParent(deviceId));
  }

  /**
   * Navigate to a path typed into the path input. The path is canonicalized
   * server-side (resolving `..` and relative paths); if it turns out to be a
   * file rather than a directory, we open its parent folder instead.
   */
  async goToPath(raw: string): Promise<void> {
    const request = this.pathRequest(raw);
    if (request === null) return this.syncPathInput();
    const target = await this.resolveWhileBusy(request);
    if (target !== null) await this.goTo(target);
  }

  /** Copy the current directory path to the clipboard. */
  async copyPath(): Promise<void> {
    if (!this.dir || !this.deps.session.isConnected()) return;
    await this.deps.feedback.attempt(async () => {
      await navigator.clipboard.writeText(this.dir);
      this.deps.feedback.success(t("sftp.pathCopied"));
    });
  }

  setSort(key: SortKey): void {
    this.sort = nextSort(this.sort, key);
    this.deps.list.selection.forgetAnchor();
    this.applyView();
  }

  /** Live directory filter — reorders the current listing without a round trip. */
  setFilter(text: string): void {
    this.filterText = text;
    // A changed filter changes the visible set, so drop the stale selection.
    this.deps.list.selection.clear();
    this.applyView();
  }

  /** Reflect the current directory in the editable path input. */
  syncPathInput(): void {
    this.deps.els().path.value = this.deps.session.isConnected() ? this.dir : "";
  }

  /** Render the entry area for a not-connected panel: a prompt to connect
   * when a device is selected, or to pick one otherwise. */
  showDisconnected(): void {
    this.deps.list.renderDisconnected(disconnectedMessage(this.deps.session));
    this.syncPathInput();
  }

  /** Render the entry area while connecting to the device named `deviceName`. */
  showConnecting(deviceName: string): void {
    this.deps.list.renderConnecting(t("sftp.connectingTo", { name: deviceName }));
    this.syncPathInput();
  }

  private show(deviceId: string, path: string, sameDir: boolean, entries: SftpEntry[]): boolean {
    // Disconnected (or switched device) while the listing was in flight.
    if (!this.deps.session.isConnectedTo(deviceId)) return false;
    this.dir = path;
    this.allEntries = entries;
    if (!sameDir) this.clearFilter();
    this.syncPathInput();
    this.applyView(); // renders + sets the count status
    this.deps.onListed();
    return true;
  }

  private failListing(deviceId: string, err: unknown): false {
    if (!this.deps.session.isConnectedTo(deviceId)) return false;
    if (this.deps.list.isConnecting()) this.showStartDirFailed();
    this.deps.feedback.report(err);
    return false;
  }

  /** Connected, but the start directory can't be listed: the path input
   * still works. */
  private showStartDirFailed(): void {
    this.deps.list.renderMessage(t("sftp.startDirFailed"));
    this.deps.controls.setStatus("");
  }

  private clearFilter(): void {
    this.filterText = "";
    this.deps.els().filter.value = "";
  }

  /** Render the filtered + sorted view of `allEntries`, the sort-header
   * indicators and the visible-count status. */
  private applyView(): void {
    const shown = viewEntries(this.allEntries, this.filterText, this.sort);
    this.deps.list.render(shown);
    renderSortHeaders(this.deps.els().root, this.sort);
    this.deps.controls.setStatus(tp("sftp.count", shown.length));
  }

  /** List a directory from history, moving the cursor only once it shows. */
  private async revisit(target: string | undefined, step: () => void): Promise<void> {
    if (target === undefined || !(await this.loadDir(target))) return;
    step();
    this.deps.controls.updateNavButtons();
  }

  private async goToParent(deviceId: string): Promise<void> {
    // Resolve `<cwd>/..` server-side so symlinked paths go to the real parent.
    const parent = await sftpRealpath(deviceId, parentOf(this.dir));
    if (parent !== this.dir) await this.goTo(parent);
  }

  private pathRequest(raw: string): PathRequest | null {
    const deviceId = this.deps.session.activeDeviceId;
    const input = raw.trim();
    return deviceId === null || input === "" ? null : { deviceId, input };
  }

  /** The directory a typed path opens, or `null` (reported) when it can't be resolved. */
  private async resolveWhileBusy({ deviceId, input }: PathRequest): Promise<string | null> {
    this.deps.controls.setBusy(true);
    const target = await resolveDirectory(deviceId, input).catch((err: unknown) => this.failResolve(err));
    this.deps.controls.setBusy(false);
    return target;
  }

  private failResolve(err: unknown): null {
    this.deps.feedback.report(err);
    this.syncPathInput();
    return null;
  }
}

/** `input` canonicalized; a path that is not a listable directory opens its
 * parent, resolving `..` server-side so the displayed path stays clean. */
async function resolveDirectory(deviceId: string, input: string): Promise<string> {
  const resolved = await sftpRealpath(deviceId, input);
  return sftpList(deviceId, resolved).then(
    () => resolved,
    () => sftpRealpath(deviceId, parentOf(resolved)),
  );
}

const SORT_ARROWS: Record<SortDir, string> = { asc: " ▲", desc: " ▼" };
const ARIA_SORT: Record<SortDir, string> = { asc: "ascending", desc: "descending" };

/** Reflect the active sort key + direction on the header buttons (an arrow on
 * the active one; `aria-sort` for assistive tech). */
function renderSortHeaders(root: HTMLElement, sort: SortState): void {
  root.querySelectorAll<HTMLButtonElement>('[data-action="sort"]').forEach((btn) => renderSortButton(btn, sort));
}

function renderSortButton(btn: HTMLButtonElement, sort: SortState): void {
  const active = btn.dataset.sort === sort.key;
  btn.textContent = t(`sftp.sort.${btn.dataset.sort as SortKey}`) + (active ? SORT_ARROWS[sort.dir] : "");
  btn.classList.toggle("is-active", active);
  btn.setAttribute("aria-sort", active ? ARIA_SORT[sort.dir] : "none");
}

function disconnectedMessage(session: PanelSession): string {
  if (session.idleDisconnected) return t("sftp.idleDisconnected");
  return session.selectedDeviceId ? t("sftp.notConnected") : t("sftp.pickDevice");
}
