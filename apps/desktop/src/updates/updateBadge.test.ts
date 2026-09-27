/**
 * @vitest-environment happy-dom
 *
 * The About-button badge: a visual dot plus an accessible label that says an
 * update is available, and survives a live language change (the label keys
 * travel in the `data-i18n-*` attributes `applyDomTranslations` re-reads).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { applyUpdateBadge } from "./updateBadge";
import { applyDomTranslations } from "../i18n";

function button(): HTMLButtonElement {
	document.body.innerHTML = `<button id="help-btn"
    data-i18n-title="header.help.title" data-i18n-aria="header.help.aria"
    title="About DaSSHboard" aria-label="About DaSSHboard"></button>`;
	return document.querySelector<HTMLButtonElement>("#help-btn") as HTMLButtonElement;
}

let btn: HTMLButtonElement;
beforeEach(() => {
	btn = button();
});

describe("applyUpdateBadge", () => {
	it("marks the button and announces the update", () => {
		applyUpdateBadge(btn, true);
		expect(btn.classList.contains("has-update")).toBe(true);
		expect(btn.getAttribute("aria-label")).toBe("About DaSSHboard (update available)");
		expect(btn.getAttribute("title")).toBe("About DaSSHboard (update available)");
	});

	it("keeps the announcement across a re-translation", () => {
		applyUpdateBadge(btn, true);
		applyDomTranslations(document);
		expect(btn.getAttribute("aria-label")).toBe("About DaSSHboard (update available)");
	});

	it("restores the plain label when the update goes away", () => {
		applyUpdateBadge(btn, true);
		applyUpdateBadge(btn, false);
		expect(btn.classList.contains("has-update")).toBe(false);
		expect(btn.getAttribute("aria-label")).toBe("About DaSSHboard");
		expect(btn.getAttribute("title")).toBe("About DaSSHboard");
	});
});
