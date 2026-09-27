/**
 * Marks the About (help) button when an update is available: an accent dot
 * (CSS `.has-update`) plus an accessible label saying so. The label keys go in
 * the button's `data-i18n-*` attributes, so a live language change
 * (`applyDomTranslations`) keeps the right wording.
 */

import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";

function setLabel(button: HTMLElement, titleKey: MessageKey, ariaKey: MessageKey): void {
	button.dataset.i18nTitle = titleKey;
	button.dataset.i18nAria = ariaKey;
	button.setAttribute("title", t(titleKey));
	button.setAttribute("aria-label", t(ariaKey));
}

export function applyUpdateBadge(button: HTMLElement, available: boolean): void {
	button.classList.toggle("has-update", available);
	if (available) setLabel(button, "header.help.updateAvailable", "header.help.updateAvailable");
	else setLabel(button, "header.help.title", "header.help.aria");
}
