/**
 * Settings controller (Phase 5): loads `settings.json`, owns the current
 * in-memory settings, renders the settings dialog, applies terminal appearance
 * live to every pane, and persists the id of the last-used profile. Thin glue
 * over the settings IPC + the `Grid`; the pure bits (theme mapping, defaults)
 * live in `../terminal/terminalSettings`.
 */

import type { Grid } from "../grid";
import { getSettings, saveSettings, type Settings, type TerminalSettings } from "../ipc";
import { DEFAULT_TERMINAL_SETTINGS } from "../terminal/terminalSettings";
import {
  SUPPORTED_LOCALES,
  applyDomTranslations,
  localeName,
  resolveLocale,
  setLocale,
  t,
} from "../i18n";

export interface SettingsControllerOptions {
  grid: Grid;
  onError: (message: string) => void;
}

const FALLBACK_SETTINGS: Settings = {
  version: 1,
  terminal: DEFAULT_TERMINAL_SETTINGS,
  lastProfileId: null,
  language: null,
};

export class SettingsController {
  private grid: Grid;
  private onError: (message: string) => void;
  private settings: Settings = FALLBACK_SETTINGS;

  constructor(options: SettingsControllerOptions) {
    this.grid = options.grid;
    this.onError = options.onError;
  }

  /** Loads persisted settings and wires the toolbar/header settings button. */
  async init(): Promise<void> {
    try {
      this.settings = await getSettings();
    } catch (err) {
      this.settings = FALLBACK_SETTINGS;
      this.onError(errorMessage(err));
    }
    // Resolve and apply the UI language before any other surface renders (this
    // runs first in `initApp`): a stored language wins, else the OS locale, else
    // English. `applyDomTranslations` translates the static `index.html` chrome;
    // views built afterwards read the now-current locale directly.
    setLocale(resolveLocale(this.settings.language));
    applyDomTranslations(document);
    document
      .querySelector<HTMLButtonElement>("#settings-btn")
      ?.addEventListener("click", () => this.openDialog());
  }

  /**
   * Re-reads settings from disk and applies terminal appearance live, without
   * writing anything back. Used by the config-reload path (multi-instance
   * sync): another running instance may have changed the font/theme, so adopt
   * whatever is now on disk. Deliberately does NOT persist — it only reflects
   * disk truth — so it can never clobber another instance's just-saved value.
   */
  async reloadFromDisk(): Promise<void> {
    try {
      const fresh = await getSettings();
      this.settings = fresh;
      this.grid.applyTerminalSettings(fresh.terminal);
      // Another instance may have changed the language; adopt it. `setLocale`
      // is a no-op when unchanged, and otherwise notifies the locale listeners
      // (wired in `main.ts`) to re-render every view.
      setLocale(resolveLocale(fresh.language));
    } catch (err) {
      this.onError(errorMessage(err));
    }
  }

  /** Current terminal appearance — read by panes when they create a terminal. */
  terminalSettings(): TerminalSettings {
    return this.settings.terminal;
  }

  /** The persisted id of the last-used profile, if any (for app-start restore). */
  lastProfileId(): string | null {
    return this.settings.lastProfileId;
  }

  /**
   * Persist the id of the profile currently loaded into the workspace (SPEC §7),
   * so it can be reloaded on the next start when no default profile is set.
   * Skips the write when the id is unchanged, so re-rendering the profile list
   * doesn't rewrite `settings.json` needlessly.
   */
  async persistLastProfileId(profileId: string | null): Promise<void> {
    if (this.settings.lastProfileId === profileId) return;
    this.settings = { ...this.settings, lastProfileId: profileId };
    await this.save();
  }

  private async applyTerminal(terminal: TerminalSettings): Promise<void> {
    this.settings = { ...this.settings, terminal };
    this.grid.applyTerminalSettings(terminal); // live to existing terminals
    await this.save();
  }

  /**
   * Apply a language choice from the settings picker: `""` clears the stored
   * language back to "follow the OS", any other value stores that locale code.
   * `setLocale` re-resolves and, if the effective locale changed, notifies the
   * locale listeners (wired in `main.ts`) so every view re-renders live; the
   * choice is then persisted.
   */
  private async applyLanguage(value: string): Promise<void> {
    const language = value === "" ? null : value;
    this.settings = { ...this.settings, language };
    setLocale(resolveLocale(language));
    await this.save();
  }

  private async save(): Promise<void> {
    try {
      // The backend sanitizes (clamps font size, defaults empty family) and
      // returns the stored value — adopt it so the UI reflects reality.
      this.settings = await saveSettings(this.settings);
    } catch (err) {
      this.onError(errorMessage(err));
    }
  }

  /* ---------------------------------------------------------------------- */

  private openDialog(): void {
    const term = this.settings.terminal;
    // The language <select>: a "System default" option (value "") that clears
    // the stored language back to OS-follow, then one option per shipped locale.
    const languageOptions = [
      `<option value="">${t("settings.language.system")}</option>`,
      ...SUPPORTED_LOCALES.map(
        (loc) => `<option value="${loc}">${localeName(loc)}</option>`,
      ),
    ].join("");
    const root = document.createElement("div");
    root.className = "dialog settings-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content settings-content">
        <div class="dialog-header"><h2>${t("settings.title")}</h2></div>
        <label class="form-field">
          <span>${t("settings.language")}</span>
          <select class="settings-language">${languageOptions}</select>
        </label>
        <label class="form-field">
          <span>${t("settings.fontSize")}</span>
          <input type="number" class="settings-font-size" min="6" max="40" step="1" />
        </label>
        <label class="form-field">
          <span>${t("settings.fontFamily")}</span>
          <input type="text" class="settings-font-family" />
        </label>
        <label class="form-field">
          <span>${t("settings.theme")}</span>
          <select class="settings-theme">
            <option value="dark">${t("settings.theme.dark")}</option>
            <option value="light">${t("settings.theme.light")}</option>
          </select>
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="close">${t("common.close")}</button>
        </div>
      </div>
    `;
    const language = root.querySelector<HTMLSelectElement>(".settings-language");
    const fontSize = root.querySelector<HTMLInputElement>(".settings-font-size");
    const fontFamily = root.querySelector<HTMLInputElement>(".settings-font-family");
    const theme = root.querySelector<HTMLSelectElement>(".settings-theme");
    // Reflect the *stored* language (null/unsupported ⇒ "System default"), not
    // the resolved one, so the picker shows what the user chose.
    if (language) language.value = this.settings.language ?? "";
    if (fontSize) fontSize.value = String(term.fontSize);
    if (fontFamily) fontFamily.value = term.fontFamily;
    if (theme) theme.value = term.theme;

    language?.addEventListener("change", () => {
      void this.applyLanguage(language.value);
    });

    // Live-apply on every change. A parsed number (including 0 / out-of-range)
    // is sent through; the backend clamps it (6..=40) and we reflect the clamped
    // value back into the field. Only a genuinely non-numeric field keeps the
    // current size.
    const apply = async (): Promise<void> => {
      const parsed = Number.parseInt(fontSize?.value ?? "", 10);
      const next: TerminalSettings = {
        fontSize: Number.isNaN(parsed) ? this.settings.terminal.fontSize : parsed,
        fontFamily: fontFamily?.value ?? this.settings.terminal.fontFamily,
        theme: theme?.value === "light" ? "light" : "dark",
      };
      await this.applyTerminal(next);
      // Reflect the backend-sanitized values (e.g. a clamped font size).
      if (fontSize) fontSize.value = String(this.settings.terminal.fontSize);
    };
    const onApply = (): void => void apply();
    fontSize?.addEventListener("change", onApply);
    fontFamily?.addEventListener("change", onApply);
    theme?.addEventListener("change", onApply);

    const previouslyFocused = document.activeElement;
    const close = (): void => {
      root.remove();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
    root.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.dataset.action;
      if (action === "close" || target.classList.contains("dialog-overlay")) {
        close();
      }
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    document.body.appendChild(root);
    fontSize?.focus();
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
