/**
 * Profile sidebar (SPEC §7, Phase 4): the saved-workspace list (Load / open in
 * new tabs / rename / delete / set-default) with a dirty-state dot and Save /
 * Save As. A profile holds one or more tabs; its open tabs are the tabs linked
 * to it, in strip order (its "group"). Thin DOM glue over the profile IPC
 * commands and the tab set; the diff/decision logic it relies on lives in the
 * pure, tested `workspace.ts`.
 */

import type { Grid } from "../grid";
import {
  deleteProfile,
  listProfiles,
  saveProfile,
  setDefaultProfile,
  exportProfiles,
  importProfiles,
  type Profile,
  type ProfileList,
  type ProfileTab,
} from "../ipc";
import {
  isDirty,
  profileTabToSnapshot,
  replaceConfirmMessage,
  shouldConfirmReplace,
  snapshotToProfileTab,
  withFirstTabName,
  type TabSnapshot,
} from "./workspace";
import { confirm, prompt } from "../ui/confirm";
import { pickJsonSavePath, pickJsonOpenPath } from "../ui/fileDialog";
import {
  pencilIcon,
  trashIcon,
  starIcon,
  starFillIcon,
  plusIcon,
  saveIcon,
  saveAsIcon,
  exportIcon,
  importIcon,
} from "../ui/icons";
import { t, tp } from "../i18n";

/**
 * Bridge to the tabbed workspace (Tabs, Phase 2). The "loaded profile" is not
 * ProfileManager state — it lives on each tab as its `linkedProfileId`, so
 * switching tabs switches which profile the list highlights. ProfileManager
 * reads/writes it through this bridge and resolves the actual `Profile` from
 * its own list. Tabs are identified by their grid: flows that await (a
 * confirm, a prompt) capture the grids first and act on them, so a tab switch
 * in the meantime can't redirect the action to the wrong tabs.
 */
export interface ProfileWorkspace {
  /** The active tab's linked-profile id, or null. */
  activeLinkedProfileId(): string | null;
  /** The active tab's group: every tab linked to its profile, in strip order,
   * or just the active tab when it is unlinked. */
  activeGroupGrids(): Grid[];
  /** The tabs linked to `profileId`, in strip order. */
  groupGrids(profileId: string): Grid[];
  /** Every profile id some tab links to, once each. */
  linkedProfileIds(): string[];
  /** Show the tab owning `grid`. */
  activateGrid(grid: Grid): void;
  /** Name + workspace of each still-open tab owning one of `grids`, in strip
   * order. */
  tabSnapshots(grids: readonly Grid[]): TabSnapshot[];
  /** Link the tab owning `grid` to a profile id (or null to unlink). A no-op if
   * that tab has since been closed. */
  linkProfile(grid: Grid, id: string | null): void;
  /** Re-render every tab's strip badge + dirty dot. */
  refreshTabStrip(): void;
  /** Unlink every tab pointing at `profileId` (used when it is deleted). */
  clearProfileLink(profileId: string): void;
  /** Open blank tabs named `names`, linked to a profile, in place of the
   * still-open tabs owning `replacing` (appended when there are none); the
   * first is activated. Returns their grids, in order, to apply into. */
  openTabs(names: string[], linkedProfileId: string, replacing?: readonly Grid[]): Promise<Grid[]>;
}

export interface ProfileManagerOptions {
  workspace: ProfileWorkspace;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
  /**
   * Fired whenever the profile loaded into the active tab changes (a load, a
   * save/save-as, the app-start restore, a tab switch, or the loaded profile
   * being deleted → `null`). Wired to persist the id as the "last-used profile"
   * so the next start can reload it when no default profile is set (SPEC §7).
   */
  onProfileChange?: (profileId: string | null) => void;
}

export class ProfileManager {
  private ws: ProfileWorkspace;
  private options: ProfileManagerOptions;
  private listEl: HTMLElement | null;

  private profiles: Profile[] = [];
  private defaultProfileId: string | null = null;
  /** The backend converted a v1 `profiles.json` on this launch (see
   * {@link adoptV1TabNames}). */
  private migratedFromV1 = false;
  /**
   * Re-entrancy guard for Load / Save / Save As / Rename (F12, same class as
   * the `Grid.transitioning` guard): each opens a dialog/persists across an
   * `await`, so a double-click could otherwise stack two prompts and create
   * two profiles from one intended save, or open a profile's tabs twice.
   */
  private busy = false;

  constructor(options: ProfileManagerOptions) {
    this.ws = options.workspace;
    this.options = options;
    this.listEl = document.querySelector<HTMLElement>(".profile-list");
  }

  /** The profile the active tab is linked to (null = unsaved / missing). */
  private activeLoaded(): Profile | null {
    return this.findProfile(this.ws.activeLinkedProfileId());
  }

  /**
   * Loads profiles and (unless `loadStart` is false) picks the profile to open
   * on start (SPEC §7): the default profile if one is set, otherwise the
   * last-used profile (`lastProfileId`, from settings) when it still exists.
   * When neither applies nothing is loaded and the initial 1x1 empty grid
   * stands. `onProfileChange` fires with the resulting profile id (or `null`).
   *
   * `loadStart` is false when the tab set was restored from `workspace_state`
   * (Tabs, Phase 3): the active tab already carries its own layout + link, so
   * loading the default/last profile over it would clobber the restore. The
   * `lastProfileId` migration still runs (loadStart true) on the first launch
   * before any workspace state exists.
   */
  async init(
    lastProfileId: string | null,
    opts: { loadStart?: boolean } = {},
  ): Promise<void> {
    await this.reload();
    await this.adoptV1TabNames();
    if (opts.loadStart ?? true) await this.openStartProfile(lastProfileId);
    this.render();
    this.refreshDirty();
    this.notifyProfileChange();
  }

  /** Opens the default profile, else the last-used one if it still exists, into
   * the initial blank tab: no teardown confirm (nothing is live yet). */
  private async openStartProfile(lastProfileId: string | null): Promise<void> {
    const start = this.findProfile(this.defaultProfileId) ?? this.findProfile(lastProfileId);
    if (start) await this.openProfile(start, this.ws.activeGroupGrids());
  }

  /**
   * One-time upgrade from single-grid (v1) profiles, whose Load linked a tab
   * without renaming it and could link several tabs to one profile: each
   * converted profile keeps its first linked tab (the others are unlinked) and
   * takes that tab's name, so restored tabs don't all read as unsaved.
   */
  private async adoptV1TabNames(): Promise<void> {
    if (!this.migratedFromV1) return;
    const renamed = this.profiles
      .map((profile) => this.adoptV1Tab(profile))
      .filter((profile): profile is Profile => profile !== null);
    if (renamed.length === 0) return;
    await this.saveAll(renamed);
    await this.reload();
  }

  /** The profile renamed after its first open tab, or null if nothing changes. */
  private adoptV1Tab(profile: Profile): Profile | null {
    const name = this.keepFirstTab(profile.id);
    if (name === undefined || name === profile.tabs[0]?.name) return null;
    return withFirstTabName(profile, name);
  }

  /** Unlinks all but the first open tab of a profile; returns that tab's name. */
  private keepFirstTab(profileId: string): string | undefined {
    const [first, ...extra] = this.ws.groupGrids(profileId);
    for (const grid of extra) this.ws.linkProfile(grid, null);
    return this.ws.tabSnapshots(first ? [first] : [])[0]?.name;
  }

  private async saveAll(profiles: readonly Profile[]): Promise<void> {
    try {
      for (const profile of profiles) await saveProfile(profile);
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
  }

  /** Looks up a profile by id in the loaded list; `null` for a missing/blank id. */
  private findProfile(id: string | null): Profile | null {
    if (!id) return null;
    return this.profiles.find((p) => p.id === id) ?? null;
  }

  /** Notifies the caller of the active tab's linked-profile id (or `null`). */
  private notifyProfileChange(): void {
    this.options.onProfileChange?.(this.ws.activeLinkedProfileId());
  }

  /** Re-fetches profiles + default id from the backend. The active tab's linked
   * profile is resolved from this list on demand. */
  async reload(): Promise<void> {
    try {
      this.applyList(await listProfiles());
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
    this.render();
    this.refreshDirty();
  }

  private applyList(list: ProfileList): void {
    this.profiles = list.profiles;
    this.defaultProfileId = list.defaultProfileId;
    this.migratedFromV1 = list.migratedFromV1;
    this.unlinkMissingProfiles();
  }

  /** Unlinks the tabs of profiles that no longer exist (deleted by another
   * instance), so they stop acting as a group. */
  private unlinkMissingProfiles(): void {
    const missing = this.ws.linkedProfileIds().filter((id) => !this.findProfile(id));
    for (const id of missing) this.ws.clearProfileLink(id);
    if (missing.length > 0) this.notifyProfileChange();
  }

  /** Whether the profile's open tabs differ from what it saved. */
  private groupDirty(profile: Profile): boolean {
    return isDirty(this.ws.tabSnapshots(this.ws.groupGrids(profile.id)), profile);
  }

  /** The profile's open tabs, in strip order, as profile tabs to save. */
  private groupTabs(profileId: string): ProfileTab[] {
    return this.ws.tabSnapshots(this.ws.groupGrids(profileId)).map(snapshotToProfileTab);
  }

  /** Recolors the loaded profile's status dot (green → gold when the active
   * tab's group is dirty) and refreshes the tab strip. */
  refreshDirty(): void {
    const dirty = this.activeDirty();
    const dot = this.listEl?.querySelector<HTMLElement>(
      ".profile-item-loaded .profile-status-dot",
    );
    if (dot) {
      dot.classList.toggle("dirty", dirty);
      dot.title = dirty ? t("profiles.bar.dirty") : t("profiles.item.current");
    }
    this.ws.refreshTabStrip();
  }

  private activeDirty(): boolean {
    const loaded = this.activeLoaded();
    return loaded !== null && this.groupDirty(loaded);
  }

  /** Re-render the bar + list and dirty state for the newly active tab. */
  onActiveTabChanged(): void {
    this.render();
    this.refreshDirty();
    this.notifyProfileChange();
  }

  /**
   * The strip badge/dot state for a tab: `linked` when its id resolves to a
   * profile, `dirty` when that profile's open tabs differ from it (so every tab
   * of a group shows the same dot). Injected into `TabManager.resolveTabState`.
   */
  resolveTabState(linkedProfileId: string | null): { linked: boolean; dirty: boolean } {
    const profile = this.findProfile(linkedProfileId);
    return {
      linked: profile !== null,
      dirty: profile !== null && this.groupDirty(profile),
    };
  }

  /** Re-render the toolbar bar + list in the current locale (language change). */
  retranslate(): void {
    this.render();
  }

  /* ---------------------------------------------------------------------- */

  private render(): void {
    this.renderList();
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.innerHTML = `
      <div class="sidebar-section-title">
        <span class="sidebar-section-title-text">${t("profiles.title")}</span>
        <div class="profile-header-actions">
          <button type="button" class="btn btn-icon profile-export-btn"
            title="${t("profiles.export.title")}" aria-label="${t("common.export")}">${exportIcon}</button>
          <button type="button" class="btn btn-icon profile-import-btn"
            title="${t("profiles.import.title")}" aria-label="${t("common.import")}">${importIcon}</button>
          <button type="button" class="btn btn-icon" data-action="save"
            title="${t("profiles.bar.save")}" aria-label="${t("profiles.bar.save")}">${saveIcon}</button>
          <button type="button" class="btn btn-icon" data-action="save-as"
            title="${t("profiles.bar.saveAs")}" aria-label="${t("profiles.bar.saveAs")}">${saveAsIcon}</button>
        </div>
      </div>
    `;
    list
      .querySelector<HTMLButtonElement>('[data-action="save"]')
      ?.addEventListener("click", () => void this.exclusive(() => this.save()));
    list
      .querySelector<HTMLButtonElement>('[data-action="save-as"]')
      ?.addEventListener("click", () => void this.exclusive(() => this.saveAs()));
    list
      .querySelector<HTMLButtonElement>(".profile-export-btn")
      ?.addEventListener("click", () => void this.exportAll());
    list
      .querySelector<HTMLButtonElement>(".profile-import-btn")
      ?.addEventListener("click", () => void this.importAll());

    if (this.profiles.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = t("profiles.empty");
      list.appendChild(empty);
      return;
    }

    for (const profile of this.profiles) {
      const item = document.createElement("div");
      item.className = "profile-item";
      const isDefault = profile.id === this.defaultProfileId;
      const isLoaded = profile.id === this.ws.activeLinkedProfileId();
      if (isLoaded) item.classList.add("profile-item-loaded");
      item.innerHTML = `
        <button type="button" class="profile-name" data-action="load"
          title="${t("profiles.item.load")}">
          <span class="profile-status-dot"${isLoaded ? "" : " hidden"}
            title="${t("profiles.item.current")}" aria-hidden="true">&bull;</span>
          <span class="profile-item-name"></span>
        </button>
        <div class="profile-item-actions">
          <button type="button" class="btn btn-icon" data-action="open-tab"
            title="${t("profiles.item.openInTab")}" aria-label="${t("profiles.item.openInTab")}">${plusIcon}</button>
          <button type="button" class="btn btn-icon${isDefault ? " btn-star-active" : ""}"
            data-action="default"
            title="${isDefault ? t("profiles.item.unsetDefault") : t("profiles.item.setDefault")}"
            aria-label="${isDefault ? t("profiles.item.unsetDefault") : t("profiles.item.setDefault")}"
            aria-pressed="${isDefault}">${isDefault ? starFillIcon : starIcon}</button>
          <button type="button" class="btn btn-icon" data-action="rename"
            title="${t("profiles.item.rename")}" aria-label="${t("profiles.item.rename")}">${pencilIcon}</button>
          <button type="button" class="btn btn-icon btn-danger" data-action="delete"
            title="${t("profiles.item.delete")}" aria-label="${t("profiles.item.delete")}">${trashIcon}</button>
        </div>
      `;
      const nameEl = item.querySelector<HTMLElement>(".profile-item-name");
      if (nameEl) nameEl.textContent = profile.name;

      item
        .querySelector<HTMLButtonElement>('[data-action="load"]')
        ?.addEventListener("click", () => void this.exclusive(() => this.load(profile)));
      item
        .querySelector<HTMLButtonElement>('[data-action="open-tab"]')
        ?.addEventListener("click", () => void this.exclusive(() => this.openInNewTab(profile)));
      item
        .querySelector<HTMLButtonElement>('[data-action="default"]')
        ?.addEventListener("click", () => void this.toggleDefault(profile, isDefault));
      item
        .querySelector<HTMLButtonElement>('[data-action="rename"]')
        ?.addEventListener("click", () => void this.exclusive(() => this.rename(profile)));
      item
        .querySelector<HTMLButtonElement>('[data-action="delete"]')
        ?.addEventListener("click", () => void this.remove(profile));
      list.appendChild(item);
    }
  }

  /* ---------------------------------------------------------------------- */

  /** Runs `action` unless another guarded action is still running (see
   * {@link busy}). */
  private async exclusive(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await action();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Loads a profile in place of the active tab's group (just the active tab
   * when it is unlinked), confirming first (see `shouldConfirmReplace`). Other
   * tabs are left alone. A profile already open in other tabs is switched to
   * instead.
   */
  private async load(profile: Profile): Promise<void> {
    if (this.switchToOtherCopy(profile)) return;
    const replacing = this.ws.activeGroupGrids();
    if (!(await this.confirmReplace(replacing))) return;
    await this.openProfile(profile, replacing);
    this.options.onSuccess(t("profiles.loaded", { name: profile.name }));
  }

  /** Like {@link switchToOpenCopy}, except that loading the active tab's own
   * profile reloads it in place (revert + reconnect). */
  private switchToOtherCopy(profile: Profile): boolean {
    if (this.ws.activeLinkedProfileId() === profile.id) return false;
    return this.switchToOpenCopy(profile);
  }

  /** Shows the profile's already-open tabs, if any: a second copy would merge
   * into the same group (twice the tabs, dirty, saved doubled). */
  private switchToOpenCopy(profile: Profile): boolean {
    const first = this.ws.groupGrids(profile.id)[0];
    if (!first) return false;
    this.ws.activateGrid(first);
    return true;
  }

  /** Asks before closing the tabs owning `grids` (see `shouldConfirmReplace`). */
  private async confirmReplace(grids: readonly Grid[]): Promise<boolean> {
    const live = grids.reduce((sum, grid) => sum + grid.liveSessionCount(), 0);
    if (!shouldConfirmReplace(grids.length, live)) return true;
    return confirm(replaceConfirmMessage(grids.length, live), {
      title: t("profiles.replace.title"),
      confirmLabel: t("common.continue"),
      danger: true,
    });
  }

  /**
   * Opens a profile's tabs in NEW tabs (leaving existing tabs untouched), linked
   * to it, and connects their panes; switches to them if already open.
   */
  private async openInNewTab(profile: Profile): Promise<void> {
    if (this.switchToOpenCopy(profile)) return;
    await this.openProfile(profile, []);
    this.options.onSuccess(t("profiles.loaded", { name: profile.name }));
  }

  /**
   * Opens one linked tab per profile tab in place of `replacing` (appended when
   * empty) and starts connecting each one's panes. The connects aren't awaited
   * (host-key prompts, timeouts), so the profile actions free up as soon as the
   * tabs exist. The tabs are fresh, so there is no teardown confirm here.
   */
  private async openProfile(profile: Profile, replacing: readonly Grid[]): Promise<void> {
    const names = profile.tabs.map((tab) => tab.name);
    const grids = await this.ws.openTabs(names, profile.id, replacing);
    profile.tabs.forEach(
      (tab, i) =>
        void grids[i]?.applySnapshot(profileTabToSnapshot(tab), { confirmTeardown: false }),
    );
    this.render();
    this.refreshDirty();
    this.notifyProfileChange();
  }

  /** Saves the active tab's profile from all of its open tabs; an unlinked
   * active tab behaves as Save As. */
  private async save(): Promise<void> {
    const loaded = this.activeLoaded();
    if (!loaded) return this.saveAs();
    await this.persist({ ...loaded, tabs: this.groupTabs(loaded.id) }, "profiles.savedProfile");
  }

  /** Saves the active tab's group (captured before the name prompt) as a new
   * profile and links those tabs to it. */
  private async saveAs(): Promise<void> {
    const grids = this.ws.activeGroupGrids();
    const name = await this.promptName(t("profiles.saveAs.title"), t("profiles.saveAs.placeholder"));
    const tabs = this.ws.tabSnapshots(grids).map(snapshotToProfileTab);
    // The tabs may all have been closed during the prompt: nothing to save.
    if (name === null || tabs.length === 0) return;
    await this.persist({ id: "", name, tabs }, "profiles.savedProfile", grids);
  }

  /** Asks for a profile name: the trimmed name, or null when cancelled or blank
   * (a blank one is reported). */
  private async promptName(title: string, placeholder: string, initial?: string): Promise<string | null> {
    const name = (await prompt(title, placeholder, initial))?.trim();
    if (name === "") this.options.onError(t("profiles.nameEmpty"));
    return name || null;
  }

  private async rename(profile: Profile): Promise<void> {
    const name = await this.promptName(
      t("profiles.rename.title"),
      t("profiles.rename.placeholder"),
      profile.name,
    );
    if (name === null) return;
    // Rename keeps the profile's stored tabs; only the name changes.
    await this.persist({ ...profile, name }, "profiles.renamedProfile");
  }

  /** Saves `profile`, then links the tabs owning `linkGrids` to it (the tabs a
   * Save As was made from). */
  private async persist(
    profile: Profile,
    successKey: "profiles.savedProfile" | "profiles.renamedProfile",
    linkGrids: readonly Grid[] = [],
  ): Promise<void> {
    try {
      const saved = await saveProfile(profile);
      for (const grid of linkGrids) this.ws.linkProfile(grid, saved.id);
      await this.reload();
      this.notifyProfileChange();
      this.options.onSuccess(t(successKey, { name: saved.name }));
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
  }

  private async remove(profile: Profile): Promise<void> {
    const ok = await confirm(t("profiles.delete.message", { name: profile.name }), {
      title: t("profiles.delete.title"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteProfile(profile.id);
      const wasActive = this.ws.activeLinkedProfileId() === profile.id;
      // Unlink EVERY tab pointing at it (active or background), so no tab keeps a
      // dangling id that would otherwise be persisted to workspace_state.json.
      this.ws.clearProfileLink(profile.id);
      await this.reload();
      // The deleted profile must not linger as the "last-used" restore target.
      if (wasActive) this.notifyProfileChange();
      this.options.onSuccess(t("profiles.deletedProfile", { name: profile.name }));
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
  }

  private async toggleDefault(profile: Profile, isDefault: boolean): Promise<void> {
    try {
      await setDefaultProfile(isDefault ? null : profile.id);
      await this.reload();
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
  }

  /**
   * Exports every profile to a user-chosen JSON file (the backend writes it,
   * excluding the per-machine default). A cancelled save dialog is a no-op.
   */
  private async exportAll(): Promise<void> {
    try {
      const path = await pickJsonSavePath("dasshboard-profiles.json");
      if (path === null) return; // user cancelled the picker
      const count = await exportProfiles(path);
      this.options.onSuccess(tp("profiles.exported", count));
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
  }

  /**
   * Imports profiles from a user-chosen JSON file (upsert by id, backend-side),
   * then reloads the list so the new entries appear. Cancel is a no-op.
   */
  private async importAll(): Promise<void> {
    try {
      const path = await pickJsonOpenPath();
      if (path === null) return; // user cancelled the picker
      const count = await importProfiles(path);
      this.options.onSuccess(tp("profiles.imported", count));
      await this.reload();
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
