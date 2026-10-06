/**
 * Settings controller (Phase 5): loads `settings.json`, owns the current
 * in-memory settings, renders the settings dialog, applies terminal appearance
 * live to every pane, and persists the id of the last-used profile. Thin glue
 * over the settings IPC; the pure bits (theme mapping, defaults) live in
 * `../terminal/terminalSettings`. Terminal appearance is pushed out through an
 * injected `applyTerminalSettings` callback (wired in `main.ts` to fan across
 * every tab's grid) rather than a direct `Grid` reference, so it stays correct
 * as the active tab changes.
 */

import {
  getSettings,
  saveSettings,
  type Settings,
  type SftpSettings,
  type TerminalSettings,
} from "../ipc";
import { DEFAULT_TERMINAL_SETTINGS } from "../terminal/terminalSettings";
import { renderThemeToggle } from "./themeToggle";
import { wireSettingsTabs } from "./settingsTabs";
import {
  FONT_SIZE,
  KEEPALIVE_COUNT,
  KEEPALIVE_INTERVAL,
  SCROLLBACK,
  SFTP_IDLE_MINS,
  parseBounded,
} from "./settingsBounds";
import {
  SUPPORTED_LOCALES,
  applyDomTranslations,
  localeName,
  onLocaleChange,
  resolveLocale,
  setLocale,
  t,
} from "../i18n";

export interface SettingsControllerOptions {
  /** Applies terminal appearance live (main.ts fans it across every tab's grid). */
  applyTerminalSettings: (settings: TerminalSettings) => void;
  /** Notified when SFTP behavior changes, so the panel can re-arm its idle
   * timer with the new timeout. Optional (unset during tests). */
  onSftpSettingsChange?: (settings: SftpSettings) => void;
  onError: (message: string) => void;
}

/** Matches the backend `KeepaliveSettings` defaults (SPEC §6). */
export const DEFAULT_KEEPALIVE_SETTINGS = {
  intervalSecs: 30,
  countMax: 3,
} as const;

/** Matches the backend `SftpSettings` defaults. */
export const DEFAULT_SFTP_SETTINGS = {
  idleDisconnectMins: 10,
  editorCommand: "",
} as const;

const FALLBACK_SETTINGS: Settings = {
  version: 1,
  terminal: DEFAULT_TERMINAL_SETTINGS,
  lastProfileId: null,
  language: null,
  keepalive: { ...DEFAULT_KEEPALIVE_SETTINGS },
  sftp: { ...DEFAULT_SFTP_SETTINGS },
  updates: { checkOnLaunch: false },
  tray: { closeToTray: false },
};

export class SettingsController {
  private applyTerminalSettings: (settings: TerminalSettings) => void;
  private onSftpSettingsChange?: (settings: SftpSettings) => void;
  private onError: (message: string) => void;
  private settings: Settings = FALLBACK_SETTINGS;

  constructor(options: SettingsControllerOptions) {
    this.applyTerminalSettings = options.applyTerminalSettings;
    this.onSftpSettingsChange = options.onSftpSettingsChange;
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
    // Apply the app-wide appearance (light/dark) before anything paints, so the
    // chrome never flashes the wrong theme. Shares the terminal's theme setting.
    this.applyAppTheme(this.settings.terminal.theme);
    // Resolve and apply the UI language before any other surface renders (this
    // runs first in `initApp`): a stored language wins, else the OS locale, else
    // English. `applyDomTranslations` translates the static `index.html` chrome;
    // views built afterwards read the now-current locale directly.
    setLocale(resolveLocale(this.settings.language));
    applyDomTranslations(document);
    document
      .querySelector<HTMLButtonElement>("#settings-btn")
      ?.addEventListener("click", () => this.openDialog());
    document
      .querySelector<HTMLButtonElement>("#theme-btn")
      ?.addEventListener("click", () => void this.toggleTheme());
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
      this.applyAppTheme(fresh.terminal.theme);
      this.applyTerminalSettings(fresh.terminal);
      this.onSftpSettingsChange?.(fresh.sftp);
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

  /** Current SFTP browser behavior — read by the SFTP panel when it arms its
   * idle-disconnect timer. */
  sftpSettings(): SftpSettings {
    return this.settings.sftp;
  }

  /** Whether the user opted in to an update check at app start. */
  checkUpdatesOnLaunch(): boolean {
    return this.settings.updates.checkOnLaunch;
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
    this.applyAppTheme(terminal.theme); // switch the chrome light/dark live
    this.applyTerminalSettings(terminal); // live to existing terminals
    await this.save();
    // The backend may sanitize further (e.g. an empty font family); keep live
    // terminals on what was actually stored.
    const stored = this.settings.terminal;
    if (!sameTerminalSettings(stored, terminal)) this.applyTerminalSettings(stored);
  }

  /**
   * Reflect the appearance choice onto the whole UI by toggling `data-theme` on
   * <html> (the CSS token layer keys light overrides off it). The terminal theme
   * and the chrome theme are one setting, so the app never looks half-lit.
   */
  private applyAppTheme(theme: TerminalSettings["theme"]): void {
    document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
    const toggle = document.querySelector<HTMLElement>("#theme-btn");
    if (toggle) renderThemeToggle(toggle, theme);
  }

  /** The header toggle: flip dark ⇄ light, live and persisted. */
  private async toggleTheme(): Promise<void> {
    const theme = this.settings.terminal.theme === "dark" ? "light" : "dark";
    await this.applyTerminal({ ...this.settings.terminal, theme });
  }

  private async applySftp(sftp: SftpSettings): Promise<void> {
    this.settings = { ...this.settings, sftp };
    this.onSftpSettingsChange?.(sftp); // re-arm the panel's idle timer
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

  /** Reflects and persists the opt-in launch update check. */
  private wireUpdateCheckbox(root: HTMLElement): void {
    const box = root.querySelector<HTMLInputElement>(".settings-check-updates");
    if (!box) return;
    box.checked = this.settings.updates.checkOnLaunch;
    box.addEventListener("change", () => {
      this.settings = { ...this.settings, updates: { checkOnLaunch: box.checked } };
      void this.save();
    });
  }

  /** The edit-in-place editor command: saved as typed, shown as stored (the
   * backend trims it). */
  private wireEditorCommand(root: HTMLElement): void {
    const input = root.querySelector<HTMLInputElement>(".settings-sftp-editor");
    if (!input) return;
    input.value = this.settings.sftp.editorCommand;
    input.addEventListener("change", async () => {
      await this.applySftp({ ...this.settings.sftp, editorCommand: input.value });
      input.value = this.settings.sftp.editorCommand;
    });
  }

  /** Reflects and persists the opt-in close-to-tray (the backend shows or
   * hides the tray icon on save). */
  private wireTrayCheckbox(root: HTMLElement): void {
    const box = root.querySelector<HTMLInputElement>(".settings-close-to-tray");
    if (!box) return;
    box.checked = this.settings.tray.closeToTray;
    box.addEventListener("change", () => void this.applyCloseToTray(box));
  }

  /** The backend stores the setting as off when it can't build the tray icon;
   * reflect that and say why. */
  private async applyCloseToTray(box: HTMLInputElement): Promise<void> {
    const wanted = box.checked;
    this.settings = { ...this.settings, tray: { closeToTray: wanted } };
    await this.save();
    box.checked = this.settings.tray.closeToTray;
    if (wanted && !box.checked) this.onError(t("settings.tray.unavailable"));
  }

  /* ---------------------------------------------------------------------- */

  private openDialog(): void {
    const term = this.settings.terminal;
    // The language <select>: a "System default" option (value "") that clears
    // the stored language back to OS-follow, then one option per shipped locale.
    const languageOptions = [
      `<option value="" data-i18n="settings.language.system">${t("settings.language.system")}</option>`,
      ...SUPPORTED_LOCALES.map(
        (loc) => `<option value="${loc}">${localeName(loc)}</option>`,
      ),
    ].join("");
    const root = document.createElement("div");
    root.className = "dialog settings-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "settings-title");
    root.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content settings-content">
        <div class="dialog-header"><h2 id="settings-title" data-i18n="settings.title">${t("settings.title")}</h2></div>
        <div class="settings-tabs" role="tablist"
          data-i18n-aria="settings.title" aria-label="${t("settings.title")}">
          <button type="button" class="settings-tab" role="tab" id="settings-tab-general"
            data-tab="general" aria-controls="settings-panel-general" aria-selected="true"
            data-i18n="settings.tab.general" tabindex="0">${t("settings.tab.general")}</button>
          <button type="button" class="settings-tab" role="tab" id="settings-tab-connections"
            data-tab="connections" aria-controls="settings-panel-connections" aria-selected="false"
            data-i18n="settings.tab.connections" tabindex="-1">${t("settings.tab.connections")}</button>
        </div>
        <div class="settings-body">
          <div class="settings-panel" role="tabpanel" id="settings-panel-general"
            data-panel="general" aria-labelledby="settings-tab-general">
            <label class="form-field">
              <span data-i18n="settings.language">${t("settings.language")}</span>
              <select class="settings-language">${languageOptions}</select>
            </label>
            <label class="form-field">
              <span data-i18n="settings.fontFamily">${t("settings.fontFamily")}</span>
              <input type="text" class="settings-font-family" />
            </label>
            <label class="form-field">
              <span data-i18n="settings.fontSize">${t("settings.fontSize")}</span>
              <input type="number" class="settings-font-size" min="6" max="40" step="1" />
            </label>
            <label class="form-field">
              <span data-i18n="settings.scrollback">${t("settings.scrollback")}</span>
              <input type="number" class="settings-scrollback" min="0" max="100000" step="100" />
              <small class="form-hint" data-i18n="settings.scrollback.hint">${t("settings.scrollback.hint")}</small>
            </label>
            <div class="form-group form-group-checkbox">
              <label>
                <input type="checkbox" class="settings-check-updates"
                  aria-describedby="settings-check-updates-hint" />
                <span data-i18n="settings.updates.checkOnLaunch">${t("settings.updates.checkOnLaunch")}</span>
              </label>
              <small class="form-hint" id="settings-check-updates-hint"
              data-i18n="settings.updates.checkOnLaunch.hint">${t("settings.updates.checkOnLaunch.hint")}</small>
            </div>
            <div class="form-group form-group-checkbox">
              <label>
                <input type="checkbox" class="settings-close-to-tray"
                  aria-describedby="settings-close-to-tray-hint" />
                <span data-i18n="settings.tray.closeToTray">${t("settings.tray.closeToTray")}</span>
              </label>
              <small class="form-hint" id="settings-close-to-tray-hint"
              data-i18n="settings.tray.closeToTray.hint">${t("settings.tray.closeToTray.hint")}</small>
            </div>
          </div>
          <div class="settings-panel" role="tabpanel" id="settings-panel-connections"
            data-panel="connections" aria-labelledby="settings-tab-connections" hidden>
            <label class="form-field">
              <span data-i18n="settings.keepalive.interval">${t("settings.keepalive.interval")}</span>
              <input type="number" class="settings-keepalive-interval" min="0" max="3600" step="5" />
              <small class="form-hint" data-i18n="settings.keepalive.interval.hint">${t("settings.keepalive.interval.hint")}</small>
            </label>
            <label class="form-field">
              <span data-i18n="settings.keepalive.countMax">${t("settings.keepalive.countMax")}</span>
              <input type="number" class="settings-keepalive-count" min="1" max="10" step="1" />
              <small class="form-hint" data-i18n="settings.keepalive.countMax.hint">${t("settings.keepalive.countMax.hint")}</small>
            </label>
            <label class="form-field">
              <span data-i18n="settings.sftp.idleDisconnect">${t("settings.sftp.idleDisconnect")}</span>
              <input type="number" class="settings-sftp-idle" min="0" max="1440" step="1" />
              <small class="form-hint" data-i18n="settings.sftp.idleDisconnect.hint">${t("settings.sftp.idleDisconnect.hint")}</small>
            </label>
            <label class="form-field">
              <span data-i18n="settings.sftp.editor">${t("settings.sftp.editor")}</span>
              <input type="text" class="settings-sftp-editor" spellcheck="false" autocomplete="off" />
              <small class="form-hint" data-i18n="settings.sftp.editor.hint">${t("settings.sftp.editor.hint")}</small>
            </label>
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="close" data-i18n="common.close">${t("common.close")}</button>
        </div>
      </div>
    `;
    const language = root.querySelector<HTMLSelectElement>(".settings-language");
    const fontSize = root.querySelector<HTMLInputElement>(".settings-font-size");
    const fontFamily = root.querySelector<HTMLInputElement>(".settings-font-family");
    const scrollback = root.querySelector<HTMLInputElement>(".settings-scrollback");
    const keepaliveInterval = root.querySelector<HTMLInputElement>(
      ".settings-keepalive-interval",
    );
    const keepaliveCount = root.querySelector<HTMLInputElement>(".settings-keepalive-count");
    const sftpIdle = root.querySelector<HTMLInputElement>(".settings-sftp-idle");
    // Reflect the *stored* language (null/unsupported ⇒ "System default"), not
    // the resolved one, so the picker shows what the user chose.
    if (language) language.value = this.settings.language ?? "";
    if (fontSize) fontSize.value = String(term.fontSize);
    if (fontFamily) fontFamily.value = term.fontFamily;
    if (scrollback) scrollback.value = String(term.scrollback);
    if (keepaliveInterval) keepaliveInterval.value = String(this.settings.keepalive.intervalSecs);
    if (keepaliveCount) keepaliveCount.value = String(this.settings.keepalive.countMax);
    if (sftpIdle) sftpIdle.value = String(this.settings.sftp.idleDisconnectMins);

    language?.addEventListener("change", () => {
      void this.applyLanguage(language.value);
    });

    // Live-apply on every change, clamped into range (see `settingsBounds`); a
    // non-numeric field keeps the current value. The stored (sanitized) values
    // are reflected back into the fields.
    const apply = async (): Promise<void> => {
      const current = this.settings.terminal;
      const next: TerminalSettings = {
        fontSize: parseBounded(fontSize?.value ?? "", current.fontSize, FONT_SIZE),
        fontFamily: fontFamily?.value ?? current.fontFamily,
        scrollback: parseBounded(scrollback?.value ?? "", current.scrollback, SCROLLBACK),
        theme: current.theme,
      };
      await this.applyTerminal(next);
      // Reflect the backend-sanitized values (e.g. a clamped font size/scrollback).
      if (fontSize) fontSize.value = String(this.settings.terminal.fontSize);
      if (scrollback) scrollback.value = String(this.settings.terminal.scrollback);
    };
    const onApply = (): void => void apply();
    fontSize?.addEventListener("change", onApply);
    fontFamily?.addEventListener("change", onApply);
    scrollback?.addEventListener("change", onApply);

    // Keepalive doesn't affect live terminals (it applies to connections opened
    // afterwards), so it only needs to be persisted — clamped, and reflected back.
    const applyKeepalive = async (): Promise<void> => {
      const current = this.settings.keepalive;
      this.settings = {
        ...this.settings,
        keepalive: {
          intervalSecs: parseBounded(keepaliveInterval?.value ?? "", current.intervalSecs, KEEPALIVE_INTERVAL),
          countMax: parseBounded(keepaliveCount?.value ?? "", current.countMax, KEEPALIVE_COUNT),
        },
      };
      await this.save();
      if (keepaliveInterval) keepaliveInterval.value = String(this.settings.keepalive.intervalSecs);
      if (keepaliveCount) keepaliveCount.value = String(this.settings.keepalive.countMax);
    };
    const onApplyKeepalive = (): void => void applyKeepalive();
    keepaliveInterval?.addEventListener("change", onApplyKeepalive);
    keepaliveCount?.addEventListener("change", onApplyKeepalive);

    // SFTP idle-disconnect: clamped, and reflected back.
    const applySftp = async (): Promise<void> => {
      const current = this.settings.sftp;
      await this.applySftp({
        ...current,
        idleDisconnectMins: parseBounded(sftpIdle?.value ?? "", current.idleDisconnectMins, SFTP_IDLE_MINS),
      });
      if (sftpIdle) sftpIdle.value = String(this.settings.sftp.idleDisconnectMins);
    };
    sftpIdle?.addEventListener("change", () => void applySftp());
    this.wireEditorCommand(root);

    this.wireUpdateCheckbox(root);
    this.wireTrayCheckbox(root);
    wireSettingsTabs(root);

    // Re-translate the open dialog the moment the language changes (its
    // strings carry `data-i18n` keys), rather than only on the next open.
    const stopRetranslating = onLocaleChange(() => applyDomTranslations(root));
    const previouslyFocused = document.activeElement;
    const close = (): void => {
      stopRetranslating();
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
    language?.focus();
  }
}

function sameTerminalSettings(a: TerminalSettings, b: TerminalSettings): boolean {
  return (
    a.fontSize === b.fontSize &&
    a.fontFamily === b.fontFamily &&
    a.scrollback === b.scrollback &&
    a.theme === b.theme
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
