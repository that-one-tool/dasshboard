/** The grid toolbar's DOM: a "Layout" label, one button per preset, and the
 * broadcast toggle pushed to their right. */

import { PRESET_IDS, type PresetId } from "../gridModel";
import { t } from "../i18n";

export interface GridToolbarHandlers {
  onPreset(id: PresetId): void;
  onBroadcast(): void;
}

/** Rebuilds `toolbar`'s buttons in the current locale. */
export function renderGridToolbar(toolbar: HTMLElement, handlers: GridToolbarHandlers): void {
  toolbar.innerHTML = "";
  const label = document.createElement("span");
  label.className = "grid-toolbar-label";
  label.textContent = t("grid.layout");
  toolbar.appendChild(label);
  for (const id of PRESET_IDS) toolbar.appendChild(createPresetButton(id, handlers));
  toolbar.appendChild(createBroadcastButton(handlers));
}

function createPresetButton(id: PresetId, handlers: GridToolbarHandlers): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-small grid-preset-btn";
  button.textContent = id;
  button.dataset.preset = id;
  button.addEventListener("click", () => handlers.onPreset(id));
  return button;
}

function createBroadcastButton(handlers: GridToolbarHandlers): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-small grid-broadcast-btn";
  button.textContent = t("grid.broadcast");
  button.title = t("grid.broadcast.aria");
  button.setAttribute("aria-label", t("grid.broadcast.aria"));
  button.addEventListener("click", () => handlers.onBroadcast());
  return button;
}

/** Highlights the preset button of `active` (none for a custom shape). */
export function markActivePreset(toolbar: HTMLElement, active: string | null): void {
  for (const button of presetButtons(toolbar)) {
    button.classList.toggle("grid-preset-active", button.dataset.preset === active);
  }
}

/** Enables/disables the preset buttons for the duration of a transition. */
export function setPresetButtonsDisabled(toolbar: HTMLElement, disabled: boolean): void {
  for (const button of presetButtons(toolbar)) button.disabled = disabled;
}

function presetButtons(toolbar: HTMLElement): NodeListOf<HTMLButtonElement> {
  return toolbar.querySelectorAll<HTMLButtonElement>(".grid-preset-btn");
}

/** Reflects broadcast mode on the toggle button (pressed state). */
export function showBroadcastButton(toolbar: HTMLElement, on: boolean): void {
  const button = toolbar.querySelector<HTMLButtonElement>(".grid-broadcast-btn");
  if (!button) return;
  button.classList.toggle("grid-broadcast-active", on);
  button.setAttribute("aria-pressed", String(on));
}
