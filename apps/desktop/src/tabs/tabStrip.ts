/** The tab strip's DOM: its chrome, one button per tab (name, profile-link
 * badge, unsaved-changes dot, close glyph), and their localized labels. */

import { t } from "../i18n";
import { requireEl } from "../ui/dom";
import { closeIcon } from "../ui/icons";

/** How a tab relates to its linked profile, for the strip badge + dirty dot. */
export interface TabProfileState {
  /** True when `linkedProfileId` resolves to an existing profile. */
  linked: boolean;
  /** True when the tab's live workspace differs from that profile. */
  dirty: boolean;
}

/** What a tab button's clicks ask for; each gets the clicked tab button. */
export interface TabButtonHandlers {
  onActivate(button: HTMLElement): void;
  onClose(button: HTMLElement): void;
  onRename(button: HTMLElement): void;
}

/** The strip (tabs + new-tab button) over the stack of tab panels. */
export function stripHtml(): string {
  return `
      <div class="tab-strip" role="tablist" aria-label="${t("tabs.aria")}">
        <div class="tab-strip-tabs"></div>
        <button type="button" class="tab-new-btn"
          title="${t("tabs.new")}" aria-label="${t("tabs.new")}"></button>
      </div>
      <div class="tab-stack"></div>
    `;
}

/** Re-labels the strip and its new-tab button in the current locale. */
export function retranslateStrip(root: ParentNode): void {
  root.querySelector<HTMLElement>(".tab-strip")?.setAttribute("aria-label", t("tabs.aria"));
  labelControl(root.querySelector<HTMLElement>(".tab-new-btn"), t("tabs.new"));
}

export function createTabButton(name: string, handlers: TabButtonHandlers): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab";
  button.setAttribute("role", "tab");
  button.innerHTML = tabButtonHtml();
  requireEl<HTMLElement>(button, ".tab-name").textContent = name;
  const close = requireEl<HTMLButtonElement>(button, ".tab-close");
  close.innerHTML = closeIcon;
  close.addEventListener("click", (e) => {
    e.stopPropagation(); // don't also activate the tab we're closing
    handlers.onClose(button);
  });
  button.addEventListener("click", () => handlers.onActivate(button));
  button.addEventListener("dblclick", (e) => {
    // Double-clicking the close glyph shouldn't start a rename.
    if (!isOnClose(e.target)) handlers.onRename(button);
  });
  return button;
}

function tabButtonHtml(): string {
  return `
      <span class="tab-name"></span>
      <span class="tab-badge" title="${t("tabs.linked")}" hidden></span>
      <span class="tab-dirty-dot" hidden></span>
      <button type="button" class="tab-close" tabindex="-1"
        title="${t("tabs.close")}" aria-label="${t("tabs.close")}"></button>
    `;
}

function isOnClose(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".tab-close") !== null;
}

/** Re-labels a tab button's close glyph and badge in the current locale. */
export function retranslateTabButton(button: HTMLElement): void {
  labelControl(button.querySelector<HTMLElement>(".tab-close"), t("tabs.close"));
  const badge = button.querySelector<HTMLElement>(".tab-badge");
  if (badge) badge.title = t("tabs.linked");
}

/** Shows a tab's profile-link badge and unsaved-changes dot from its state. */
export function showTabState(button: HTMLElement, state: TabProfileState): void {
  const badge = button.querySelector<HTMLElement>(".tab-badge");
  if (badge) badge.hidden = !state.linked;
  const dot = button.querySelector<HTMLElement>(".tab-dirty-dot");
  if (dot) dot.hidden = !state.dirty;
}

function labelControl(control: HTMLElement | null, label: string): void {
  if (!control) return;
  control.title = label;
  control.setAttribute("aria-label", label);
}
