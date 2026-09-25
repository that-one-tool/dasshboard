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
 * Each tab tracks the profile it is linked to (`linkedProfileId`); the strip
 * renders a per-tab profile-link badge and dirty dot, computed by an injected
 * `resolveTabState` (Phase 2 — `ProfileManager` provides it). `main.ts` targets
 * `activeGrid()` and fans refresh/retranslate calls across `forEachGrid`.
 */

import { Grid, type GridOptions } from "../grid";
import { confirm } from "../ui/confirm";
import { requireEl } from "../ui/dom";
import { closeIcon, plusIcon } from "../ui/icons";
import { shrinkConfirmMessage } from "../gridModel";
import { t } from "../i18n";
import type { SftpPanelState, WorkspaceState } from "../ipc";

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

/** How a tab relates to its linked profile, for the strip badge + dirty dot. */
export interface TabProfileState {
  /** True when `linkedProfileId` resolves to an existing profile. */
  linked: boolean;
  /** True when the tab's live workspace differs from that profile. */
  dirty: boolean;
}

export interface TabManagerOptions {
  /** Shared per-grid options, passed verbatim to every tab's `Grid`. */
  grid: GridOptions;
  /** Fired after the active tab changes (so the profile bar can re-render). */
  onActiveTabChange?: () => void;
  /** Resolves a tab's profile-link + dirty state for the strip (ProfileManager). */
  resolveTabState?: (linkedProfileId: string | null, grid: Grid) => TabProfileState;
  /** Persists the serialized workspace (debounced by the manager). */
  persist?: (state: WorkspaceState) => void;
  /**
   * Contributes the Files (SFTP) panel's state into the persisted workspace
   * (they share `workspace_state.json`). Returns `undefined` until the panel has
   * been used, so the file stays clean. The panel triggers a save via
   * {@link scheduleSave}.
   */
  getSftpState?: () => SftpPanelState | undefined;
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
  /** Monotonic counter so fresh blank tabs get stable default names. */
  private nextTabNumber = 1;
  /**
   * Guards persistence during `init`/restore: no save is scheduled until the
   * initial build finishes, so restoring N tabs doesn't rewrite the file N times
   * (and the very first save is a real change, not the restore echo).
   */
  private ready = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private stripTabs: HTMLElement | null = null;
  private stack: HTMLElement | null = null;

  constructor(root: HTMLElement, options: TabManagerOptions) {
    this.root = root;
    this.options = options;
  }

  /**
   * Builds the strip + stack, then either restores the saved tabs (when
   * `state` has any) or opens a single blank 1x1 tab (cold start / the
   * `lastProfileId` migration path, where `ProfileManager` loads the start
   * profile into that blank tab afterwards).
   */
  async init(state?: WorkspaceState): Promise<void> {
    this.root.classList.add("tab-root");
    this.root.innerHTML = `
      <div class="tab-strip" role="tablist" aria-label="${t("tabs.aria")}">
        <div class="tab-strip-tabs"></div>
        <button type="button" class="tab-new-btn"
          title="${t("tabs.new")}" aria-label="${t("tabs.new")}"></button>
      </div>
      <div class="tab-stack"></div>
    `;
    this.stripTabs = requireEl<HTMLElement>(this.root, ".tab-strip-tabs");
    this.stack = requireEl<HTMLElement>(this.root, ".tab-stack");

    const newBtn = requireEl<HTMLButtonElement>(this.root, ".tab-new-btn");
    newBtn.innerHTML = plusIcon;
    newBtn.addEventListener("click", () => void this.newTab());

    // Mount the app-action buttons at the right end of the strip row (they live
    // here now instead of a separate app header).
    const actions = this.options.headerActions;
    if (actions) {
      actions.hidden = false;
      requireEl<HTMLElement>(this.root, ".tab-strip").appendChild(actions);
    }

    window.addEventListener("keydown", this.onKeyDown, true);
    // Flush any debounced save before the window tears down, so a fast quit
    // doesn't drop the last ≤500 ms of workspace changes.
    window.addEventListener("beforeunload", this.onBeforeUnload);

    if (state && state.tabs.length > 0) {
      await this.restore(state);
    } else {
      await this.newTab();
    }
    this.ready = true;
  }

  /**
   * Re-render the strip's localized chrome in the current locale (language
   * change). Tab *names* are user data and left untouched; only the aria/title
   * strings on the strip, the new-tab button, and each tab's close button +
   * profile-link badge are refreshed. Live grids are re-translated separately.
   */
  retranslate(): void {
    this.root
      .querySelector<HTMLElement>(".tab-strip")
      ?.setAttribute("aria-label", t("tabs.aria"));
    const newBtn = this.root.querySelector<HTMLElement>(".tab-new-btn");
    if (newBtn) {
      newBtn.title = t("tabs.new");
      newBtn.setAttribute("aria-label", t("tabs.new"));
    }
    for (const tab of this.tabs) {
      const close = tab.button.querySelector<HTMLElement>(".tab-close");
      if (close) {
        close.title = t("tabs.close");
        close.setAttribute("aria-label", t("tabs.close"));
      }
      const badge = tab.button.querySelector<HTMLElement>(".tab-badge");
      if (badge) badge.title = t("tabs.linked");
    }
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

  /** Opens a new blank 1x1 tab (the chosen new-tab default) and activates it. */
  async newTab(): Promise<void> {
    await this.createTab(
      t("tabs.untitled", { index: String(this.nextTabNumber++) }),
      null,
    );
  }

  /**
   * Opens a tab pre-linked to a profile and activates it, returning its grid so
   * the caller (`ProfileManager.openInNewTab`) can apply the profile into it.
   */
  async openTab(opts: { name: string; linkedProfileId: string }): Promise<Grid> {
    return this.createTab(opts.name, opts.linkedProfileId);
  }

  /** Builds a tab (panel + grid + strip button), appends it, and activates it. */
  private async createTab(name: string, linkedProfileId: string | null): Promise<Grid> {
    const stack = this.stack;
    const stripTabs = this.stripTabs;
    if (!stack || !stripTabs) throw new Error("TabManager.init() has not run");

    // The panel is a plain visibility wrapper; the grid gets its OWN host child.
    // Grid.init() adds `.grid-root` (display:flex) to whatever element it's given,
    // so if the panel itself were the grid root, that flex rule would override
    // `.tab-hidden`'s display:none and every tab would stay visible side by side.
    const panel = document.createElement("div");
    panel.className = "tab-panel tab-hidden";
    const host = document.createElement("div");
    panel.appendChild(host);
    stack.appendChild(panel);

    // Wrap the shared grid onChange so a workspace edit in ANY tab both bubbles
    // to the app (dirty dot) and schedules a persist of the whole tab set.
    const grid = new Grid(host, {
      ...this.options.grid,
      onChange: () => {
        this.options.grid.onChange?.();
        this.schedulePersist();
      },
    });
    await grid.init();

    const tab: Tab = {
      grid,
      panel,
      button: this.createTabButton(name),
      name,
      linkedProfileId,
    };
    this.tabs.push(tab);
    stripTabs.appendChild(tab.button);
    this.refreshStrip();
    this.activate(this.tabs.length - 1);
    this.schedulePersist();
    return grid;
  }

  /**
   * Closes a tab (disposing its grid, which closes any live session). If it
   * carries live sessions the user confirms first, reusing the grid-shrink
   * teardown copy. The final tab is never left empty — closing it opens a fresh
   * blank tab in its place.
   */
  async closeTab(index: number): Promise<void> {
    const tab = this.tabs[index];
    if (!tab) return;

    const live = tab.grid.liveSessionCount();
    if (live > 0) {
      const ok = await confirm(shrinkConfirmMessage(live), {
        title: t("grid.closeSessions.title"),
        confirmLabel: t("common.continue"),
        danger: true,
      });
      if (!ok) return;
    }

    tab.grid.dispose();
    tab.panel.remove();
    tab.button.remove();
    this.tabs.splice(index, 1);

    if (this.tabs.length === 0) {
      await this.newTab();
      return;
    }
    // Activate a sensible neighbour: the tab that shifted into this slot, or the
    // new last tab if we closed the tail.
    const next = Math.min(index, this.tabs.length - 1);
    this.activeIndex = -1; // force activate() to re-apply visibility
    this.activate(next);
    this.refreshStrip();
    this.schedulePersist();
  }

  /**
   * Shows tab `index` and hides the rest, then re-fits the now-visible grid (a
   * hidden panel can't be measured) and focuses its pane. Notifies
   * `onActiveTabChange` so the profile bar re-renders for the new active tab.
   */
  activate(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.activeIndex = index;
    this.tabs.forEach((tab, i) => {
      const active = i === index;
      tab.panel.classList.toggle("tab-hidden", !active);
      tab.button.classList.toggle("tab-active", active);
      tab.button.setAttribute("aria-selected", String(active));
    });
    const tab = this.tabs[index];
    if (!tab) return;
    tab.grid.refit();
    tab.grid.focus();
    this.options.onActiveTabChange?.();
    this.schedulePersist();
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

  /** The active tab's linked-profile id (or null) — read by `ProfileManager`. */
  activeLinkedProfileId(): string | null {
    return this.tabs[this.activeIndex]?.linkedProfileId ?? null;
  }

  /** Sets the active tab's linked-profile id and refreshes its strip badge/dot. */
  setActiveLinkedProfileId(id: string | null): void {
    const tab = this.tabs[this.activeIndex];
    if (tab) tab.linkedProfileId = id;
    this.refreshStrip();
    this.schedulePersist();
  }

  /**
   * Unlinks EVERY tab pointing at `profileId` (used when that profile is
   * deleted, so no tab — active or background — keeps a dangling id that would
   * otherwise be persisted). Refreshes the strip + schedules a save only if
   * something actually changed.
   */
  clearProfileLink(profileId: string): void {
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.linkedProfileId === profileId) {
        tab.linkedProfileId = null;
        changed = true;
      }
    }
    if (changed) {
      this.refreshStrip();
      this.schedulePersist();
    }
  }

  /* -------------------------------------------------------------------------
   * Persistence (Tabs, Phase 3)
   * ---------------------------------------------------------------------- */

  /** Snapshots every tab into the persisted `WorkspaceState` shape. */
  serialize(): WorkspaceState {
    return {
      tabs: this.tabs.map((tab) => {
        const snap = tab.grid.snapshot();
        return {
          name: tab.name,
          grid: snap.grid,
          panes: snap.panes.map((deviceId) => ({ deviceId })),
          linkedProfileId: tab.linkedProfileId,
        };
      }),
      activeIndex: Math.max(0, this.activeIndex),
      sftp: this.options.getSftpState?.(),
    };
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
    if (!this.ready || !this.options.persist) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.options.persist?.(this.serialize());
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Writes any pending debounced save immediately (called on app quit). */
  flushPersist(): void {
    if (this.persistTimer === null) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.options.persist?.(this.serialize());
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
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    button.setAttribute("role", "tab");
    button.innerHTML = `
      <span class="tab-name"></span>
      <span class="tab-badge" title="${t("tabs.linked")}" hidden></span>
      <span class="tab-dirty-dot" hidden></span>
      <button type="button" class="tab-close" tabindex="-1"
        title="${t("tabs.close")}" aria-label="${t("tabs.close")}"></button>
    `;
    requireEl<HTMLElement>(button, ".tab-name").textContent = name;
    const close = requireEl<HTMLButtonElement>(button, ".tab-close");
    close.innerHTML = closeIcon;
    close.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also activate the tab we're closing
      const index = this.tabs.findIndex((tb) => tb.button === button);
      if (index >= 0) void this.closeTab(index);
    });
    button.addEventListener("click", () => {
      const index = this.tabs.findIndex((tb) => tb.button === button);
      if (index >= 0) this.activate(index);
    });
    button.addEventListener("dblclick", (e) => {
      // Double-clicking the close glyph shouldn't start a rename.
      if (e.target instanceof HTMLElement && e.target.closest(".tab-close")) return;
      const index = this.tabs.findIndex((tb) => tb.button === button);
      if (index >= 0) this.startRename(index);
    });
    return button;
  }

  /**
   * Inline-renames a tab: swaps its name label for a text input (double-click).
   * Enter / blur commits a non-empty trimmed value; Escape cancels. Pointer
   * events inside the input are stopped so they don't re-activate or close the
   * tab underneath.
   */
  private startRename(index: number): void {
    const tab = this.tabs[index];
    if (!tab) return;
    const nameEl = tab.button.querySelector<HTMLElement>(".tab-name");
    if (!nameEl || tab.button.querySelector(".tab-rename-input")) return; // already editing

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tab-rename-input";
    input.value = tab.name;
    input.setAttribute("aria-label", t("tabs.rename"));
    nameEl.hidden = true;
    nameEl.after(input);
    input.focus();
    input.select();

    for (const type of ["mousedown", "click", "dblclick"] as const) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      if (commit) {
        const next = input.value.trim();
        if (next && next !== tab.name) {
          tab.name = next;
          nameEl.textContent = next;
          this.schedulePersist();
        }
      }
      input.remove();
      nameEl.hidden = false;
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  /**
   * Reflects per-tab profile state onto the strip: the profile-link badge and
   * the unsaved-changes dot, computed by the injected `resolveTabState` (or
   * hidden when none is wired yet, e.g. during initial construction).
   */
  refreshStrip(): void {
    for (const tab of this.tabs) {
      const state = this.options.resolveTabState?.(tab.linkedProfileId, tab.grid) ?? {
        linked: false,
        dirty: false,
      };
      const badge = tab.button.querySelector<HTMLElement>(".tab-badge");
      if (badge) badge.hidden = !state.linked;
      const dot = tab.button.querySelector<HTMLElement>(".tab-dirty-dot");
      if (dot) dot.hidden = !state.dirty;
    }
  }

  /* -------------------------------------------------------------------------
   * Keyboard (capture phase, so tab combos win over xterm's key handling).
   * Shift is required on T/W to avoid clobbering a shell's Ctrl+W (delete word)
   * / Ctrl+T (transpose). Ctrl+Tab cycles.
   * ---------------------------------------------------------------------- */

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!e.ctrlKey) return;
    const key = e.key.toLowerCase();
    if (e.shiftKey && key === "t") {
      e.preventDefault();
      e.stopPropagation();
      void this.newTab();
    } else if (e.shiftKey && key === "w") {
      e.preventDefault();
      e.stopPropagation();
      void this.closeTab(this.activeIndex);
    } else if (key === "tab") {
      e.preventDefault();
      e.stopPropagation();
      this.cycle(e.shiftKey ? -1 : 1);
    }
  };

  private cycle(delta: number): void {
    const n = this.tabs.length;
    if (n <= 1) return;
    this.activate((this.activeIndex + delta + n) % n);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.flushPersist();
    for (const tab of this.tabs) {
      tab.grid.dispose();
      tab.panel.remove();
      tab.button.remove();
    }
    this.tabs = [];
  }
}
