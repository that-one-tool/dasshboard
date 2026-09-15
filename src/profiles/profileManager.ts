/**
 * Profile sidebar + toolbar (SPEC §7, Phase 4): the saved-layout list (Load /
 * rename / delete / set-default) and the toolbar bar showing the current
 * profile name with a dirty-state dot and Save / Save As. Thin DOM glue over
 * the profile IPC commands and the `Grid`; the diff/decision logic it relies on
 * lives in the pure, tested `workspace.ts`.
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
} from "../ipc";
import { isDirty, snapshotToProfileFields } from "./workspace";
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
} from "../ui/icons";
import { t, tp } from "../i18n";

/**
 * Bridge to the tabbed workspace (Tabs, Phase 2). The "loaded profile" is no
 * longer ProfileManager state — it lives on the active tab as its
 * `linkedProfileId`, so switching tabs switches which profile the bar reflects.
 * ProfileManager reads/writes it through this bridge and resolves the actual
 * `Profile` from its own list.
 */
export interface ProfileWorkspace {
  /** The active tab's grid (what load/save/dirty act on). */
  activeGrid(): Grid;
  /** The active tab's linked-profile id, or null. */
  activeLinkedProfileId(): string | null;
  /** Link the active tab to a profile id (or null to unlink). */
  setActiveLinkedProfileId(id: string | null): void;
  /** Re-render every tab's strip badge + dirty dot. */
  refreshTabStrip(): void;
  /** Unlink every tab pointing at `profileId` (used when it is deleted). */
  clearProfileLink(profileId: string): void;
  /** Open a new tab pre-linked to a profile; returns its grid to apply into. */
  openTab(opts: { name: string; linkedProfileId: string }): Promise<Grid>;
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
  private barEl: HTMLElement | null;

  private profiles: Profile[] = [];
  private defaultProfileId: string | null = null;
  /**
   * Re-entrancy guard for Save / Save As / Rename (F12, same class as the
   * `Grid.transitioning` guard): each opens a `prompt()`/persists across an
   * `await`, so a double-click could otherwise stack two prompts and create
   * two profiles from one intended save.
   */
  private busy = false;

  constructor(options: ProfileManagerOptions) {
    this.ws = options.workspace;
    this.options = options;
    this.listEl = document.querySelector<HTMLElement>(".profile-list");
    this.barEl = document.querySelector<HTMLElement>("#profile-bar");
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
    if (opts.loadStart ?? true) {
      // Default wins; else fall back to the last-used profile if it still exists.
      const start = this.findProfile(this.defaultProfileId) ?? this.findProfile(lastProfileId);
      if (start) {
        // App-start load: no teardown confirm (nothing is live yet).
        await this.ws.activeGrid().applyProfile(start, { confirmTeardown: false });
        this.ws.setActiveLinkedProfileId(start.id);
      }
    }
    this.render();
    this.refreshDirty();
    this.notifyProfileChange();
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
   * profile is resolved from this list on demand, so nothing to re-sync here. */
  async reload(): Promise<void> {
    try {
      const list = await listProfiles();
      this.profiles = list.profiles;
      this.defaultProfileId = list.defaultProfileId;
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
    this.render();
    this.refreshDirty();
  }

  /** Recomputes the toolbar dirty dot (active tab) and refreshes the tab strip. */
  refreshDirty(): void {
    const dirty = isDirty(this.ws.activeGrid().snapshot(), this.activeLoaded());
    const dot = this.barEl?.querySelector<HTMLElement>(".profile-dirty-dot");
    if (dot) dot.hidden = !dirty;
    this.ws.refreshTabStrip();
  }

  /** Re-render the bar + list and dirty state for the newly active tab. */
  onActiveTabChanged(): void {
    this.render();
    this.refreshDirty();
    this.notifyProfileChange();
  }

  /**
   * The strip badge/dot state for a tab: `linked` when its id resolves to a
   * profile, `dirty` when the tab's live workspace differs from it. Injected
   * into `TabManager.resolveTabState`.
   */
  resolveTabState(
    linkedProfileId: string | null,
    grid: Grid,
  ): { linked: boolean; dirty: boolean } {
    const profile = this.findProfile(linkedProfileId);
    return {
      linked: profile !== null,
      dirty: profile !== null && isDirty(grid.snapshot(), profile),
    };
  }

  /** Re-render the toolbar bar + list in the current locale (language change). */
  retranslate(): void {
    this.render();
  }

  /* ---------------------------------------------------------------------- */

  private render(): void {
    this.renderBar();
    this.renderList();
  }

  private renderBar(): void {
    const bar = this.barEl;
    if (!bar) return;
    bar.innerHTML = `
      <div class="profile-bar-info">
        <span class="profile-current-label">${t("profiles.bar.label")}</span>
        <span class="profile-current-name"></span>
        <span class="profile-dirty-dot" title="${t("profiles.bar.dirty")}" hidden>&bull;</span>
      </div>
      <div class="profile-bar-actions">
        <button type="button" class="btn btn-icon" data-action="save"
          title="${t("profiles.bar.save")}" aria-label="${t("profiles.bar.save")}">${saveIcon}</button>
        <button type="button" class="btn btn-icon" data-action="save-as"
          title="${t("profiles.bar.saveAs")}" aria-label="${t("profiles.bar.saveAs")}">${saveAsIcon}</button>
      </div>
    `;
    const name = bar.querySelector<HTMLElement>(".profile-current-name");
    const loaded = this.activeLoaded();
    if (name) name.textContent = loaded ? loaded.name : t("profiles.bar.unsaved");

    bar
      .querySelector<HTMLButtonElement>('[data-action="save"]')
      ?.addEventListener("click", () => void this.save());
    bar
      .querySelector<HTMLButtonElement>('[data-action="save-as"]')
      ?.addEventListener("click", () => void this.saveAs());
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.innerHTML = `
      <div class="sidebar-section-title">${t("profiles.title")}</div>
      <div class="section-actions">
        <button type="button" class="btn btn-small profile-export-btn"
          title="${t("profiles.export.title")}">${t("common.export")}</button>
        <button type="button" class="btn btn-small profile-import-btn"
          title="${t("profiles.import.title")}">${t("common.import")}</button>
      </div>
    `;
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
        ?.addEventListener("click", () => void this.load(profile));
      item
        .querySelector<HTMLButtonElement>('[data-action="open-tab"]')
        ?.addEventListener("click", () => void this.openInNewTab(profile));
      item
        .querySelector<HTMLButtonElement>('[data-action="default"]')
        ?.addEventListener("click", () => void this.toggleDefault(profile, isDefault));
      item
        .querySelector<HTMLButtonElement>('[data-action="rename"]')
        ?.addEventListener("click", () => void this.rename(profile));
      item
        .querySelector<HTMLButtonElement>('[data-action="delete"]')
        ?.addEventListener("click", () => void this.remove(profile));
      list.appendChild(item);
    }
  }

  /* ---------------------------------------------------------------------- */

  private async load(profile: Profile): Promise<void> {
    const applied = await this.ws.activeGrid().applyProfile(profile);
    if (!applied) return; // user cancelled the teardown confirm
    this.ws.setActiveLinkedProfileId(profile.id);
    this.render();
    this.refreshDirty();
    this.notifyProfileChange();
    this.options.onSuccess(t("profiles.loaded", { name: profile.name }));
  }

  /**
   * Opens a profile in a NEW tab (leaving existing tabs untouched), links that
   * tab to it, and connects its panes. The new tab is empty, so no teardown
   * confirm is needed.
   */
  private async openInNewTab(profile: Profile): Promise<void> {
    // Behind the busy guard so a rapid double-click can't open two identical
    // tabs (each `openTab` makes a fresh grid, so the Grid transition guard that
    // protects `load` doesn't apply here).
    if (this.busy) return;
    this.busy = true;
    try {
      const grid = await this.ws.openTab({ name: profile.name, linkedProfileId: profile.id });
      await grid.applyProfile(profile, { confirmTeardown: false });
      this.render();
      this.refreshDirty();
      this.notifyProfileChange();
      this.options.onSuccess(t("profiles.loaded", { name: profile.name }));
    } finally {
      this.busy = false;
    }
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const loaded = this.activeLoaded();
      if (!loaded) {
        // Nothing loaded yet → behave as Save As.
        await this.performSaveAs();
        return;
      }
      await this.persist({ ...loaded, ...snapshotToProfileFields(this.ws.activeGrid().snapshot()) }, "profiles.savedProfile");
    } finally {
      this.busy = false;
    }
  }

  private async saveAs(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.performSaveAs();
    } finally {
      this.busy = false;
    }
  }

  /** Shared Save-As body; callers (`save`, `saveAs`) hold the `busy` guard. */
  private async performSaveAs(): Promise<void> {
    const name = await prompt(t("profiles.saveAs.title"), t("profiles.saveAs.placeholder"));
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      this.options.onError(t("profiles.nameEmpty"));
      return;
    }
    await this.persist(
      { id: "", name: trimmed, ...snapshotToProfileFields(this.ws.activeGrid().snapshot()) },
      "profiles.savedProfile",
    );
  }

  private async rename(profile: Profile): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const name = await prompt(t("profiles.rename.title"), t("profiles.rename.placeholder"), profile.name);
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) {
        this.options.onError(t("profiles.nameEmpty"));
        return;
      }
      // Rename keeps the profile's stored layout; only the name changes.
      await this.persist({ ...profile, name: trimmed }, "profiles.renamedProfile");
    } finally {
      this.busy = false;
    }
  }

  private async persist(profile: Profile, successKey: "profiles.savedProfile" | "profiles.renamedProfile"): Promise<void> {
    try {
      const saved = await saveProfile(profile);
      // If we saved the active tab's loaded profile (or just created one via Save
      // As from its live workspace), link the active tab to it so the dirty dot
      // clears. A rename of some *other* profile leaves the active link alone.
      const link = this.ws.activeLinkedProfileId();
      if (link === null || link === saved.id || profile.id === "") {
        this.ws.setActiveLinkedProfileId(saved.id);
      }
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
