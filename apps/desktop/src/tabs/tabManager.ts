/**
 * The tab strip and the stack of per-tab workspaces (Tabs milestone, Phase 1).
 *
 * A "tab" is one full workspace: an independent {@link Grid} (its shape,
 * splitter sizes, pane assignments and live SSH sessions). All tabs stay
 * instantiated at once — only the active tab's panel is visible; the rest are
 * `display:none` (`.tab-hidden`) so their background SSH sessions keep running
 * and buffering. Because a hidden panel has zero size, xterm's FitAddon can't
 * measure it, so {@link Grid.refit} runs on every activation once the panel is
 * shown again.
 *
 * Each tab tracks the profile it is linked to (`linkedProfileId`); the tabs
 * linked to one profile, in strip order, are that profile's open tabs (its
 * "group"). The strip renders a per-tab profile-link badge and dirty dot,
 * computed by the resolver set with `setTabStateResolver` (`ProfileManager`). `main.ts` targets `activeGrid()` and fans refresh/retranslate
 * calls across `forEachGrid`.
 */

import { Grid, type GridOptions } from "../grid";
import { isDialogOpen, requireEl } from "../ui/dom";
import { tabShortcut, type TabAction, type TabJump, type TabShortcut } from "./tabShortcuts";
import { plusIcon } from "../ui/icons";
import { confirmSessionTeardown } from "../ui/sessionTeardown";
import { t } from "../i18n";
import type { WorkspaceState, WorkspaceTabState } from "../ipc";
import type { TabSnapshot } from "../profiles/workspace";
import { DebouncedWrite } from "./debouncedWrite";
import { startRename } from "./tabRename";
import {
  createTabButton,
  retranslateStrip,
  retranslateTabButton,
  showTabState,
  stripHtml,
  type TabProfileState,
} from "./tabStrip";

export type { TabProfileState } from "./tabStrip";

/** One open tab: its live grid, the panel it lives in, and its strip button. */
interface Tab {
  grid: Grid;
  /** Grid root (a `.tab-panel`); carries `.tab-hidden` while inactive. */
  panel: HTMLElement;
  /** The tab's button in the strip. */
  button: HTMLElement;
  name: string;
  /** Profile this tab is linked to (drives the badge + dirty diff), or null. */
  linkedProfileId: string | null;
}

/** What other parts of the window store in `workspace_state.json`. */
export type WorkspaceExtras = Omit<WorkspaceState, "tabs" | "activeIndex">;

export interface TabManagerOptions {
  /** Shared per-grid options, passed to every tab's `Grid`; its change and
   * connection events reach the listeners registered on the manager. */
  grid: Omit<GridOptions, "onChange" | "onConnectionChange">;
  /** Persists the serialized workspace (debounced by the manager). */
  persist?: (state: WorkspaceState) => void;
  /**
   * The app-action buttons (reload / trusted-hosts / settings / help), mounted
   * into the right side of the tab-strip row so the app has no separate header.
   * Unhidden once mounted.
   */
  headerActions?: HTMLElement | null;
}

/** How long to coalesce workspace changes before writing `workspace_state.json`. */
const PERSIST_DEBOUNCE_MS = 500;

export class TabManager {
  private root: HTMLElement;
  private options: TabManagerOptions;
  private tabs: Tab[] = [];
  private activeIndex = 0;
  /** Tabs whose close is waiting on the live-session confirm (a repeated close
   * request for the same tab is ignored meanwhile). */
  private readonly closing = new Set<Tab>();
  /** Monotonic counter so fresh blank tabs get stable default names. */
  private nextTabNumber = 1;
  /**
   * Guards persistence during `init`/restore: no save is scheduled until the
   * initial build finishes, so restoring N tabs doesn't rewrite the file N times
   * (and the very first save is a real change, not the restore echo).
   */
  private ready = false;
  private readonly saver = new DebouncedWrite(() => this.options.persist?.(this.serialize()), PERSIST_DEBOUNCE_MS);

  /** The profile links of tabs still being built, so a {@link clearProfileLink}
   * that runs meanwhile reaches them too. */
  private readonly pendingLinks = new Set<{ profileId: string | null }>();

  private stripTabs: HTMLElement | null = null;
  private stack: HTMLElement | null = null;

  private readonly workspaceListeners: (() => void)[] = [];
  private readonly activeTabListeners: (() => void)[] = [];
  private readonly connectionListeners: (() => void)[] = [];
  private readonly stateContributors: (() => WorkspaceExtras)[] = [];
  private resolveTabState = (_linkedProfileId: string | null): TabProfileState => ({
    linked: false,
    dirty: false,
  });

  constructor(root: HTMLElement, options: TabManagerOptions) {
    this.root = root;
    this.options = options;
  }

  /** A workspace edit in any tab (dirty state may have changed). */
  onWorkspaceChange(listener: () => void): void {
    this.workspaceListeners.push(listener);
  }

  onActiveTabChange(listener: () => void): void {
    this.activeTabListeners.push(listener);
  }

  /** A pane in any tab connected or disconnected. */
  onConnectionChange(listener: () => void): void {
    this.connectionListeners.push(listener);
  }

  /** Adds state saved alongside the tabs (they share `workspace_state.json`);
   * read at each save, which the contributor triggers with {@link scheduleSave}.
   * On a shared key the later contributor wins; it never replaces the tabs. */
  addStateContributor(contribute: () => WorkspaceExtras): void {
    this.stateContributors.push(contribute);
  }

  /** How a tab relates to its linked profile, for the strip badge + dirty dot. */
  setTabStateResolver(resolve: (linkedProfileId: string | null) => TabProfileState): void {
    this.resolveTabState = resolve;
  }

  /**
   * Builds the strip + stack, then either restores the saved tabs (when
   * `state` has any) or opens a single blank 1x1 tab (cold start / the
   * `lastProfileId` migration path, where `ProfileManager` loads the start
   * profile into that blank tab afterwards).
   */
  async init(state?: WorkspaceState): Promise<void> {
    this.buildStrip();
    this.mountHeaderActions();
    window.addEventListener("keydown", this.onKeyDown, true);
    // Flush any debounced save before the window tears down, so a fast quit
    // doesn't drop the last ≤500 ms of workspace changes.
    window.addEventListener("beforeunload", this.onBeforeUnload);
    await this.openInitialTabs(state);
    this.ready = true;
  }

  private buildStrip(): void {
    this.root.classList.add("tab-root");
    this.root.innerHTML = stripHtml();
    this.stripTabs = requireEl<HTMLElement>(this.root, ".tab-strip-tabs");
    this.stack = requireEl<HTMLElement>(this.root, ".tab-stack");
    const newBtn = requireEl<HTMLButtonElement>(this.root, ".tab-new-btn");
    newBtn.innerHTML = plusIcon;
    newBtn.addEventListener("click", () => void this.newTab());
  }

  /** Mounts the app-action buttons at the right end of the strip row (they
   * live here instead of a separate app header). */
  private mountHeaderActions(): void {
    const actions = this.options.headerActions;
    if (!actions) return;
    actions.hidden = false;
    requireEl<HTMLElement>(this.root, ".tab-strip").appendChild(actions);
  }

  private async openInitialTabs(state: WorkspaceState | undefined): Promise<void> {
    if (state && state.tabs.length > 0) await this.restore(state);
    else await this.newTab();
  }

  /**
   * Re-render the strip's localized chrome in the current locale (language
   * change). Tab *names* are user data and left untouched; only the aria/title
   * strings on the strip, the new-tab button, and each tab's close button +
   * profile-link badge are refreshed. Live grids are re-translated separately.
   */
  retranslate(): void {
    retranslateStrip(this.root);
    for (const tab of this.tabs) retranslateTabButton(tab.button);
  }

  /**
   * Rebuilds every saved tab (name + link + grid snapshot, auto-connecting its
   * panes) and activates the saved active index. Runs while `ready` is false so
   * no intermediate save fires.
   */
  private async restore(state: WorkspaceState): Promise<void> {
    for (const ts of state.tabs) {
      const grid = await this.createTab(ts.name, ts.linkedProfileId);
      await grid.applySnapshot(
        { grid: ts.grid, panes: ts.panes.map((p) => p.deviceId) },
        { confirmTeardown: false },
      );
    }
    // Keep default names ahead of any "Tab N" that were restored, so a later new
    // tab doesn't collide with a restored default name.
    this.nextTabNumber = this.tabs.length + 1;
    const active = Math.min(Math.max(state.activeIndex, 0), this.tabs.length - 1);
    this.activeIndex = -1; // force activate() to re-apply visibility
    this.activate(active);
  }

  /* -------------------------------------------------------------------------
   * Tab lifecycle
   * ---------------------------------------------------------------------- */

  /** Opens a new blank 1x1 tab (the chosen new-tab default) and activates it.
   * It joins the active tab's profile, if any (that's how a profile gains a
   * tab). */
  async newTab(): Promise<void> {
    await this.createTab(
      t("tabs.untitled", { index: String(this.nextTabNumber++) }),
      this.activeLinkedProfileId(),
    );
  }

  /**
   * Opens a copy of tab `index` right after it: the same layout and devices,
   * connected afresh, in the source's profile. Named "<name> (copy)". Skipped
   * while the source is still building a loaded layout's panes.
   */
  async duplicateTab(index: number): Promise<void> {
    const source = this.tabs[index];
    if (!source?.grid.isSnapshotComplete()) return;
    const snapshot = source.grid.snapshot();
    const grid = await this.createTab(
      t("tabs.copyName", { name: source.name }),
      source.linkedProfileId,
      () => this.slotAfter(source),
    );
    await grid.applySnapshot(snapshot, { confirmTeardown: false });
  }

  /** Right after `tab`, or the end once it has been closed. */
  private slotAfter(tab: Tab): number {
    const index = this.tabs.indexOf(tab);
    return index >= 0 ? index + 1 : this.tabs.length;
  }

  /**
   * Opens blank tabs named `names`, linked to a profile, so the caller
   * (`ProfileManager`) can apply the profile's tabs into the returned grids. They
   * take the place of the still-open tabs owning `replacing`, which are closed
   * without a confirm (the caller asked); with none, they are appended. The
   * first new tab ends up active.
   */
  async openTabs(
    names: string[],
    linkedProfileId: string,
    replacing: readonly Grid[] = [],
  ): Promise<Grid[]> {
    const grids: Grid[] = [];
    for (const name of names) {
      grids.push(await this.createTab(name, linkedProfileId, () => this.openSlot(grids, replacing)));
    }
    // New tabs first, so replacing every tab never empties the strip.
    await this.removeTabsOwning(replacing);
    this.activateFirst(grids);
    return grids;
  }

  private activateFirst(grids: Grid[]): void {
    if (grids[0]) this.activateGrid(grids[0]);
  }

  /** Closes, without a confirm, the tabs owning `grids` that are still open
   * (any can have been closed while the caller awaited). */
  private async removeTabsOwning(grids: readonly Grid[]): Promise<void> {
    for (const tab of this.tabs.filter((candidate) => grids.includes(candidate.grid))) {
      await this.removeIfOpen(tab);
    }
  }

  private async removeIfOpen(tab: Tab): Promise<void> {
    if (this.tabs.includes(tab)) await this.removeTab(tab);
  }

  /** Where the next tab of an {@link openTabs} batch goes: after the last one it
   * opened, else where the first still-open replaced tab is, else the end. */
  private openSlot(opened: readonly Grid[], replacing: readonly Grid[]): number {
    const last = this.tabs.findIndex((tab) => tab.grid === opened.at(-1));
    if (last >= 0) return last + 1;
    return this.indexOrEnd(this.tabs.findIndex((tab) => replacing.includes(tab.grid)));
  }

  private indexOrEnd(index: number): number {
    return index >= 0 ? index : this.tabs.length;
  }

  /**
   * Builds a tab (panel + grid + strip button), inserts it at `slot()` (the end
   * by default), and activates it. The slot is resolved once the grid has
   * initialized, since tabs can open or close while it does.
   */
  private async createTab(
    name: string,
    linkedProfileId: string | null,
    slot: () => number = () => this.tabs.length,
  ): Promise<Grid> {
    const { stack, stripTabs } = this.requireStrip();
    const { panel, host } = createTabPanel(stack);
    const grid = this.createGrid(host);
    const profileId = await this.initGrid(grid, linkedProfileId);
    const tab: Tab = { grid, panel, button: this.createTabButton(name), name, linkedProfileId: profileId };
    this.insertTab(tab, slot(), stack, stripTabs);
    return grid;
  }

  private requireStrip(): { stack: HTMLElement; stripTabs: HTMLElement } {
    const { stack, stripTabs } = this;
    if (!stack || !stripTabs) throw new Error("TabManager.init() has not run");
    return { stack, stripTabs };
  }

  /** Wraps the shared grid onChange so a workspace edit in ANY tab both bubbles
   * to the app (dirty dot) and schedules a persist of the whole tab set. */
  private createGrid(host: HTMLElement): Grid {
    return new Grid(host, {
      ...this.options.grid,
      onChange: () => this.notifyWorkspaceChange(),
      onConnectionChange: () => notifyAll(this.connectionListeners),
    });
  }

  /** Initializes `grid`; resolves the tab's profile link, which a
   * {@link clearProfileLink} meanwhile may have cleared. */
  private async initGrid(grid: Grid, linkedProfileId: string | null): Promise<string | null> {
    const link = { profileId: linkedProfileId };
    this.pendingLinks.add(link);
    try {
      await grid.init();
    } finally {
      this.pendingLinks.delete(link);
    }
    return link.profileId;
  }

  private insertTab(tab: Tab, index: number, stack: HTMLElement, stripTabs: HTMLElement): void {
    const before = this.tabs[index];
    const [panelAfter, buttonAfter] = before ? [before.panel, before.button] : [null, null];
    stack.insertBefore(tab.panel, panelAfter);
    this.tabs.splice(index, 0, tab);
    stripTabs.insertBefore(tab.button, buttonAfter);
    this.refreshStrip();
    this.activate(index);
    this.schedulePersist();
  }

  /**
   * Closes a tab (disposing its grid, which closes any live session). If it
   * carries live sessions the user confirms first, reusing the grid-shrink
   * teardown copy. The final tab is never left empty — closing it opens a fresh
   * blank tab in its place.
   */
  async closeTab(index: number): Promise<void> {
    const tab = this.closableTab(index);
    if (!tab) return;
    // The tab set may have changed during the confirm: act on this tab, by
    // identity, wherever it now sits.
    if (await this.confirmCloseOnce(tab)) await this.removeIfOpen(tab);
  }

  /** Tab `index`, unless absent or already waiting on its close confirm. */
  private closableTab(index: number): Tab | undefined {
    const tab = this.tabs[index];
    return tab && !this.closing.has(tab) ? tab : undefined;
  }

  private async confirmCloseOnce(tab: Tab): Promise<boolean> {
    this.closing.add(tab);
    try {
      return await this.confirmClose(tab);
    } finally {
      this.closing.delete(tab);
    }
  }

  /** Asks before closing a tab that has live sessions. */
  private async confirmClose(tab: Tab): Promise<boolean> {
    const live = tab.grid.liveSessionCount();
    if (live === 0) return true;
    return confirmSessionTeardown(live);
  }

  private async removeTab(tab: Tab): Promise<void> {
    const index = this.tabs.indexOf(tab);
    const active = this.tabs[this.activeIndex];
    destroyTab(tab);
    this.tabs.splice(index, 1);

    if (this.tabs.length === 0) {
      await this.newTab();
      return;
    }
    const next = this.indexAfterRemoval(active, tab, index);
    this.activeIndex = -1; // force activate() to re-apply visibility
    this.activate(next);
    this.refreshStrip();
    // A closed tab leaves its profile's group (→ dirty).
    this.notifyWorkspaceChange();
  }

  /** Closing a background tab keeps the active one; closing the active tab
   * moves to the tab that shifted into its slot (or the new last tab). */
  private indexAfterRemoval(active: Tab | undefined, removed: Tab, index: number): number {
    if (active && active !== removed) return this.tabs.indexOf(active);
    return Math.min(index, this.tabs.length - 1);
  }

  /**
   * Shows tab `index` and hides the rest, then re-fits the now-visible grid (a
   * hidden panel can't be measured) and focuses its pane. Notifies
   * `onActiveTabChange` so the profile bar re-renders for the new active tab.
   */
  activate(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.activeIndex = index;
    this.tabs.forEach((tab, i) => showActive(tab, i === index));
    this.showActiveGrid();
  }

  /** Re-fits the now-visible active grid (a hidden panel can't be measured),
   * focuses its pane, tells the active-tab listeners and schedules a save. */
  private showActiveGrid(): void {
    const tab = this.tabs[this.activeIndex];
    if (!tab) return;
    tab.grid.refit();
    tab.grid.focus();
    notifyAll(this.activeTabListeners);
    this.schedulePersist();
  }

  /** Shows the tab owning `grid` (a no-op once that tab is closed). */
  activateGrid(grid: Grid): void {
    this.activate(this.tabs.findIndex((tab) => tab.grid === grid));
  }

  /* -------------------------------------------------------------------------
   * Accessors for main.ts (active-grid targeting + fan-out)
   * ---------------------------------------------------------------------- */

  /** The grid of the active tab (what profile/settings actions target). */
  activeGrid(): Grid {
    const grid = this.tabs[this.activeIndex]?.grid;
    if (!grid) throw new Error("TabManager: no active grid");
    return grid;
  }

  /** Re-fits the active tab's grid after the space around it changed (side
   * menu resized or collapsed). A no-op while the first tab is being built. */
  refitActive(): void {
    this.tabs[this.activeIndex]?.grid.refit();
  }

  /** The active tab's linked-profile id (or null) — read by `ProfileManager`. */
  activeLinkedProfileId(): string | null {
    return this.tabs[this.activeIndex]?.linkedProfileId ?? null;
  }

  /** How many distinct devices are connected in some pane of some tab. */
  connectedDeviceCount(): number {
    return new Set(this.tabs.flatMap((tab) => tab.grid.connectedDeviceIds())).size;
  }

  /** Every profile id some tab links to, once each — tabs still being built
   * included, so a profile missing on disk is unlinked from them too. */
  linkedProfileIds(): string[] {
    const pending = [...this.pendingLinks].map((link) => link.profileId);
    const ids = [...this.tabs.map((tab) => tab.linkedProfileId), ...pending];
    return [...new Set(ids.filter((id): id is string => id !== null))];
  }

  /** The grids of the tabs linked to `profileId`, in strip order. */
  groupGrids(profileId: string): Grid[] {
    return this.tabs.filter((tab) => tab.linkedProfileId === profileId).map((tab) => tab.grid);
  }

  /** The active tab's group: its profile's tabs, or the active tab alone when
   * it is unlinked. */
  activeGroupGrids(): Grid[] {
    const id = this.activeLinkedProfileId();
    return id === null ? [this.activeGrid()] : this.groupGrids(id);
  }

  /** Name + workspace snapshot of each still-open tab owning one of `grids`,
   * in strip order. */
  tabSnapshots(grids: readonly Grid[]): TabSnapshot[] {
    return this.tabs
      .filter((tab) => grids.includes(tab.grid))
      .map((tab) => ({ name: tab.name, ...tab.grid.snapshot() }));
  }

  /** Links the tab owning `grid` (a no-op once that tab is closed) and
   * refreshes the strip badge/dot. */
  setLinkedProfileId(grid: Grid, id: string | null): void {
    const tab = this.tabs.find((candidate) => candidate.grid === grid);
    if (!tab) return;
    tab.linkedProfileId = id;
    this.refreshStrip();
    this.schedulePersist();
  }

  /**
   * Unlinks EVERY tab pointing at `profileId` (used when that profile is
   * deleted, so no tab — active or background — keeps a dangling id that would
   * otherwise be persisted), including tabs still being built. Refreshes the
   * strip + schedules a save only if something actually changed.
   */
  clearProfileLink(profileId: string): void {
    this.clearPendingLinks(profileId);
    const linked = this.tabs.filter((tab) => tab.linkedProfileId === profileId);
    for (const tab of linked) tab.linkedProfileId = null;
    if (linked.length === 0) return;
    this.refreshStrip();
    this.schedulePersist();
  }

  private clearPendingLinks(profileId: string): void {
    for (const link of this.pendingLinks) {
      if (link.profileId === profileId) link.profileId = null;
    }
  }

  /* -------------------------------------------------------------------------
   * Persistence (Tabs, Phase 3)
   * ---------------------------------------------------------------------- */

  /** Snapshots every tab into the persisted `WorkspaceState` shape. */
  serialize(): WorkspaceState {
    return {
      ...this.collectExtras(),
      tabs: this.tabs.map(tabState),
      activeIndex: Math.max(0, this.activeIndex),
    };
  }

  private collectExtras(): WorkspaceExtras {
    const extras: WorkspaceExtras = {};
    for (const contribute of this.stateContributors) Object.assign(extras, contribute());
    return extras;
  }

  /** A tab-level edit (rename, close) that, like a grid edit, can change a
   * profile's dirty state: notify the app and schedule a save. */
  private notifyWorkspaceChange(): void {
    notifyAll(this.workspaceListeners);
    this.schedulePersist();
  }

  /** Schedule a debounced workspace save from an external contributor (the SFTP
   * panel, when its state changes). A no-op before `init` finishes. */
  scheduleSave(): void {
    this.schedulePersist();
  }

  /**
   * Debounced save of the whole tab set. No-op until `ready` (so restore and the
   * initial blank tab don't write), and only when a `persist` callback is wired.
   */
  private schedulePersist(): void {
    if (this.ready && this.options.persist) this.saver.schedule();
  }

  /** Writes any pending debounced save immediately (called on app quit). */
  flushPersist(): void {
    this.saver.flush();
  }

  private onBeforeUnload = (): void => this.flushPersist();

  /** Run `fn` against every tab's grid (device/settings/locale/reload fan-out). */
  forEachGrid(fn: (grid: Grid) => void): void {
    for (const tab of this.tabs) fn(tab.grid);
  }

  /** Map every tab's grid to a value — e.g. collecting the `refreshDevices()`
   * promises for a `Promise.allSettled` in the reload path. */
  mapGrids<T>(fn: (grid: Grid) => T): T[] {
    return this.tabs.map((tab) => fn(tab.grid));
  }

  /* -------------------------------------------------------------------------
   * Strip rendering
   * ---------------------------------------------------------------------- */

  private createTabButton(name: string): HTMLElement {
    return createTabButton(name, {
      onActivate: (button) => this.withButtonIndex(button, (index) => this.activate(index)),
      onClose: (button) => this.withButtonIndex(button, (index) => void this.closeTab(index)),
      onRename: (button) => this.withButtonIndex(button, (index) => this.startRename(index)),
    });
  }

  private withButtonIndex(button: HTMLElement, action: (index: number) => void): void {
    const index = this.tabs.findIndex((tab) => tab.button === button);
    if (index >= 0) action(index);
  }

  private startRename(index: number): void {
    const tab = this.tabs[index];
    if (!tab) return;
    startRename(tab.button, tab.name, (next) => this.renameTab(tab, next));
  }

  private renameTab(tab: Tab, name: string): void {
    tab.name = name;
    this.notifyWorkspaceChange();
  }

  /**
   * Reflects per-tab profile state onto the strip: the profile-link badge and
   * the unsaved-changes dot (both hidden until a resolver is set).
   */
  refreshStrip(): void {
    for (const tab of this.tabs) showTabState(tab.button, this.resolveTabState(tab.linkedProfileId));
  }

  /* -------------------------------------------------------------------------
   * Keyboard (capture phase, so tab combos win over xterm's key handling).
   * The key map lives in `tabShortcuts.ts`.
   * ---------------------------------------------------------------------- */

  private onKeyDown = (e: KeyboardEvent): void => {
    const shortcut = tabShortcut(e);
    if (!shortcut || !this.claims(shortcut)) return;
    e.preventDefault();
    e.stopPropagation();
    this.runShortcut(shortcut);
  };

  /** Whether a shortcut is the strip's to take. Not while a dialog holds the
   * keyboard, nor a jump to a tab that doesn't exist: the key then reaches the
   * terminal, where Ctrl+3..8 send control codes (Ctrl+5 is the telnet escape). */
  private claims(shortcut: TabShortcut): boolean {
    if (isDialogOpen()) return false;
    return typeof shortcut === "string" || this.jumpIndex(shortcut) < this.tabs.length;
  }

  /** Swallowed but not run while saved tabs are restoring: a tab opened then
   * would shift the indices the restore is filling in. */
  private runShortcut(shortcut: TabShortcut): void {
    if (!this.ready) return;
    if (typeof shortcut === "object") this.jump(shortcut);
    else this.shortcutActions[shortcut]();
  }

  private readonly shortcutActions: Record<TabAction, () => void> = {
    new: () => void this.newTab(),
    close: () => void this.closeTab(this.activeIndex),
    duplicate: () => void this.duplicateTab(this.activeIndex),
    next: () => this.cycle(1),
    previous: () => this.cycle(-1),
  };

  private jump(target: TabJump): void {
    this.activate(this.jumpIndex(target));
  }

  private jumpIndex({ jumpTo }: TabJump): number {
    return jumpTo === "last" ? this.tabs.length - 1 : jumpTo;
  }

  private cycle(delta: number): void {
    const n = this.tabs.length;
    if (n <= 1) return;
    this.activate((this.activeIndex + delta + n) % n);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.flushPersist();
    this.tabs.forEach(destroyTab);
    this.tabs = [];
  }
}

function notifyAll(listeners: readonly (() => void)[]): void {
  for (const listener of listeners) listener();
}

/**
 * A hidden tab panel in `stack`. The panel is a plain visibility wrapper; the
 * grid gets its OWN host child. Grid.init() adds `.grid-root` (display:flex) to
 * whatever element it's given, so if the panel itself were the grid root, that
 * flex rule would override `.tab-hidden`'s display:none and every tab would
 * stay visible side by side.
 */
function createTabPanel(stack: HTMLElement): { panel: HTMLElement; host: HTMLElement } {
  const panel = document.createElement("div");
  panel.className = "tab-panel tab-hidden";
  const host = document.createElement("div");
  panel.appendChild(host);
  stack.appendChild(panel);
  return { panel, host };
}

function showActive(tab: Tab, active: boolean): void {
  tab.panel.classList.toggle("tab-hidden", !active);
  tab.button.classList.toggle("tab-active", active);
  tab.button.setAttribute("aria-selected", String(active));
}

function destroyTab(tab: Tab): void {
  tab.grid.dispose();
  tab.panel.remove();
  tab.button.remove();
}

function tabState(tab: Tab): WorkspaceTabState {
  const snap = tab.grid.snapshot();
  return {
    name: tab.name,
    grid: snap.grid,
    panes: snap.panes.map((deviceId) => ({ deviceId })),
    linkedProfileId: tab.linkedProfileId,
  };
}
