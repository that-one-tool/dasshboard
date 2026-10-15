/** A terminal pane's markup, and its relabel on a language change. */

import { t } from "../../i18n";
import type { MessageKey } from "../../i18n/en";
import { disconnectIcon, fileDownIcon, searchIcon } from "../../ui/icons";
import { findKeyHintKey } from "../searchBar";

export function paneMarkup(): string {
  return `<div class="pane">${headerMarkup()}${bodyMarkup()}</div>`;
}

function iconButton(className: string, label: string, icon: string, attrs = ""): string {
  return `<button type="button" class="btn btn-icon ${className}" ${attrs}
    title="${label}" aria-label="${label}">${icon}</button>`;
}

function headerMarkup(): string {
  return `
    <div class="pane-header">
      <select class="pane-device-select" aria-label="${t("pane.deviceSelect.aria")}"></select>
      ${iconButton("pane-connect", t("pane.connect"), disconnectIcon)}
      ${iconButton("pane-disconnect", t("pane.disconnect"), disconnectIcon, "hidden")}
      <span class="pane-tools">
        ${iconButton("pane-find", t(findKeyHintKey()), searchIcon, "disabled")}
        ${iconButton("pane-save-output", t("pane.saveOutput"), fileDownIcon, "disabled")}
      </span>
      <span class="pane-status">
        <span class="pane-status-dot" aria-hidden="true"></span>
        <span class="pane-status-label"></span>
      </span>
    </div>`;
}

function bodyMarkup(): string {
  return `
    <div class="pane-body">
      <div class="pane-terminal"></div>
      <div class="pane-overlay dialog-hidden" role="status">
        <div class="overlay-inner">
          <div class="overlay-spinner" hidden></div>
          <div class="overlay-title"></div>
          <div class="overlay-detail"></div>
          <button type="button" class="btn btn-primary overlay-retry" hidden>${t("pane.retry")}</button>
          <button type="button" class="btn btn-secondary overlay-cancel" hidden>${t("pane.cancel")}</button>
        </div>
      </div>
    </div>`;
}

/** Icon buttons: relabel the tooltip + accessible name, never the content. */
const ICON_LABELS: ReadonlyArray<[string, () => MessageKey]> = [
  [".pane-connect", () => "pane.connect"],
  [".pane-disconnect", () => "pane.disconnect"],
  [".pane-find", findKeyHintKey],
  [".pane-save-output", () => "pane.saveOutput"],
];

const TEXT_LABELS: ReadonlyArray<[string, MessageKey]> = [
  [".overlay-retry", "pane.retry"],
  [".overlay-cancel", "pane.cancel"],
];

export function relabelPane(root: HTMLElement): void {
  relabelIcons(root);
  relabelTexts(root);
  root.querySelector(".pane-device-select")?.setAttribute("aria-label", t("pane.deviceSelect.aria"));
}

function relabelIcons(root: HTMLElement): void {
  for (const [selector, key] of ICON_LABELS) {
    root.querySelectorAll<HTMLElement>(selector).forEach((button) => setIconLabel(button, t(key())));
  }
}

function relabelTexts(root: HTMLElement): void {
  for (const [selector, key] of TEXT_LABELS) {
    root.querySelectorAll(selector).forEach((el) => (el.textContent = t(key)));
  }
}

function setIconLabel(button: HTMLElement, label: string): void {
  button.title = label;
  button.setAttribute("aria-label", label);
}
