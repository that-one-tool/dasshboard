/**
 * The header's dark/light toggle. It shows the theme a click switches TO — a
 * sun while dark, a crescent moon while light — and its label names that
 * action. The label keys go in the `data-i18n-*` attributes, so a live language
 * change (`applyDomTranslations`) keeps the right wording.
 */

import type { TerminalSettings } from "../ipc";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { moonIcon, sunIcon } from "../ui/icons";

export function renderThemeToggle(button: HTMLElement, theme: TerminalSettings["theme"]): void {
	const dark = theme === "dark";
	const label: MessageKey = dark ? "header.theme.toLight" : "header.theme.toDark";
	button.innerHTML = dark ? sunIcon : moonIcon;
	button.dataset.i18nTitle = label;
	button.dataset.i18nAria = label;
	button.setAttribute("title", t(label));
	button.setAttribute("aria-label", t(label));
}
