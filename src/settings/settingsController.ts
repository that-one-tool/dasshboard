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

export interface SettingsControllerOptions {
  grid: Grid;
  onError: (message: string) => void;
}

const FALLBACK_SETTINGS: Settings = {
  version: 1,
  terminal: DEFAULT_TERMINAL_SETTINGS,
  lastProfileId: null,
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
    document
      .querySelector<HTMLButtonElement>("#settings-btn")
      ?.addEventListener("click", () => this.openDialog());
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
    const t = this.settings.terminal;
    const root = document.createElement("div");
    root.className = "dialog settings-dialog";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-content settings-content">
        <div class="dialog-header"><h2>Terminal settings</h2></div>
        <label class="form-field">
          <span>Font size</span>
          <input type="number" class="settings-font-size" min="6" max="40" step="1" />
        </label>
        <label class="form-field">
          <span>Font family</span>
          <input type="text" class="settings-font-family" />
        </label>
        <label class="form-field">
          <span>Theme</span>
          <select class="settings-theme">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" data-action="close">Close</button>
        </div>
      </div>
    `;
    const fontSize = root.querySelector<HTMLInputElement>(".settings-font-size");
    const fontFamily = root.querySelector<HTMLInputElement>(".settings-font-family");
    const theme = root.querySelector<HTMLSelectElement>(".settings-theme");
    if (fontSize) fontSize.value = String(t.fontSize);
    if (fontFamily) fontFamily.value = t.fontFamily;
    if (theme) theme.value = t.theme;

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
      if (target.dataset.action === "close" || target.classList.contains("dialog-overlay")) {
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
