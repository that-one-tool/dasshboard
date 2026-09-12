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
import { pencilIcon, trashIcon, starIcon, starFillIcon } from "../ui/icons";
import { t, tp } from "../i18n";

export interface ProfileManagerOptions {
  grid: Grid;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
  /**
   * Fired whenever the profile loaded into the workspace changes (a load, a
   * save/save-as, the app-start restore, or the loaded profile being deleted →
   * `null`). Wired to persist the id as the "last-used profile" so the next
   * start can reload it when no default profile is set (SPEC §7).
   */
  onProfileChange?: (profileId: string | null) => void;
}

export class ProfileManager {
  private grid: Grid;
  private options: ProfileManagerOptions;
  private listEl: HTMLElement | null;
  private barEl: HTMLElement | null;

  private profiles: Profile[] = [];
  private defaultProfileId: string | null = null;
  /** The profile currently loaded into the workspace (null = unsaved 1x1). */
  private loaded: Profile | null = null;
  /**
   * Re-entrancy guard for Save / Save As / Rename (F12, same class as the
   * `Grid.transitioning` guard): each opens a `prompt()`/persists across an
   * `await`, so a double-click could otherwise stack two prompts and create
   * two profiles from one intended save.
   */
  private busy = false;

  constructor(options: ProfileManagerOptions) {
    this.grid = options.grid;
    this.options = options;
    this.listEl = document.querySelector<HTMLElement>(".profile-list");
    this.barEl = document.querySelector<HTMLElement>("#profile-bar");
  }

  /**
   * Loads profiles and picks the profile to open on start (SPEC §7): the default
   * profile if one is set, otherwise the last-used profile (`lastProfileId`, from
   * settings) when it still exists. When neither applies nothing is loaded and
   * the initial 1x1 empty grid stands. `onProfileChange` fires with the resulting
   * profile id (or `null`) so the caller can record it as the new last-used.
   */
  async init(lastProfileId: string | null): Promise<void> {
    await this.reload();
    // Default wins; else fall back to the last-used profile if it still exists.
    const start = this.findProfile(this.defaultProfileId) ?? this.findProfile(lastProfileId);
    if (start) {
      // App-start load: no teardown confirm (nothing is live yet).
      await this.grid.applyProfile(start, { confirmTeardown: false });
      this.loaded = start;
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

  /** Notifies the caller of the currently-loaded profile id (or `null`). */
  private notifyProfileChange(): void {
    this.options.onProfileChange?.(this.loaded?.id ?? null);
  }

  /** Re-fetches profiles + default id from the backend and re-syncs `loaded`. */
  async reload(): Promise<void> {
    try {
      const list = await listProfiles();
      this.profiles = list.profiles;
      this.defaultProfileId = list.defaultProfileId;
      // Keep the in-memory loaded profile in sync with the backend (e.g. after
      // a device deletion nulled a pane out of it).
      if (this.loaded) {
        this.loaded = this.profiles.find((p) => p.id === this.loaded?.id) ?? this.loaded;
      }
    } catch (err) {
      this.options.onError(errorMessage(err));
    }
    this.render();
    this.refreshDirty();
  }

  /** Recomputes and renders the dirty-state dot for the toolbar. */
  refreshDirty(): void {
    const dirty = isDirty(this.grid.snapshot(), this.loaded);
    const dot = this.barEl?.querySelector<HTMLElement>(".profile-dirty-dot");
    if (dot) dot.hidden = !dirty;
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
      <span class="profile-current-label">${t("profiles.bar.label")}</span>
      <span class="profile-current-name"></span>
      <span class="profile-dirty-dot" title="${t("profiles.bar.dirty")}" hidden>&bull;</span>
      <span class="profile-bar-spacer"></span>
      <button type="button" class="btn btn-small btn-secondary" data-action="save">${t("profiles.bar.save")}</button>
      <button type="button" class="btn btn-small btn-secondary" data-action="save-as">${t("profiles.bar.saveAs")}</button>
    `;
    const name = bar.querySelector<HTMLElement>(".profile-current-name");
    if (name) name.textContent = this.loaded ? this.loaded.name : t("profiles.bar.unsaved");

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
      const isLoaded = profile.id === this.loaded?.id;
      if (isLoaded) item.classList.add("profile-item-loaded");
      item.innerHTML = `
        <button type="button" class="profile-name" data-action="load"
          title="${t("profiles.item.load")}">
          <span class="profile-item-name"></span>
        </button>
        <div class="profile-item-actions">
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
    const applied = await this.grid.applyProfile(profile);
    if (!applied) return; // user cancelled the teardown confirm
    this.loaded = profile;
    this.render();
    this.refreshDirty();
    this.notifyProfileChange();
    this.options.onSuccess(t("profiles.loaded", { name: profile.name }));
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.loaded) {
        // Nothing loaded yet → behave as Save As.
        await this.performSaveAs();
        return;
      }
      await this.persist({ ...this.loaded, ...snapshotToProfileFields(this.grid.snapshot()) }, "profiles.savedProfile");
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
      { id: "", name: trimmed, ...snapshotToProfileFields(this.grid.snapshot()) },
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
      // If we saved the currently-loaded profile (or just created one via Save
      // As from the live workspace), it becomes the loaded profile so the dirty
      // dot clears.
      if (this.loaded === null || this.loaded.id === saved.id || profile.id === "") {
        this.loaded = saved;
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
      const wasLoaded = this.loaded?.id === profile.id;
      if (wasLoaded) this.loaded = null;
      await this.reload();
      // The deleted profile must not linger as the "last-used" restore target.
      if (wasLoaded) this.notifyProfileChange();
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
