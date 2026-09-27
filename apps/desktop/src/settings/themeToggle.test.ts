/**
 * @vitest-environment happy-dom
 *
 * The header theme toggle shows the theme a click switches TO: a sun while
 * dark, a crescent moon while light. Its label names that action and survives a
 * live language change (the keys travel in the `data-i18n-*` attributes).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderThemeToggle } from "./themeToggle";
import { moonIcon, sunIcon } from "../ui/icons";
import { applyDomTranslations } from "../i18n";

/** An icon as the DOM serializes it (happy-dom expands self-closing tags). */
function parsed(svg: string): string {
	const div = document.createElement("div");
	div.innerHTML = svg;
	return div.innerHTML;
}

let btn: HTMLButtonElement;
beforeEach(() => {
	document.body.innerHTML = '<button id="theme-btn"></button>';
	btn = document.querySelector<HTMLButtonElement>("#theme-btn") as HTMLButtonElement;
});

describe("renderThemeToggle", () => {
	it("shows a sun and offers the light theme while dark", () => {
		renderThemeToggle(btn, "dark");
		expect(btn.innerHTML).toBe(parsed(sunIcon));
		expect(btn.getAttribute("title")).toBe("Switch to light theme");
		expect(btn.getAttribute("aria-label")).toBe("Switch to light theme");
	});

	it("shows a crescent moon and offers the dark theme while light", () => {
		renderThemeToggle(btn, "light");
		expect(btn.innerHTML).toBe(parsed(moonIcon));
		expect(btn.getAttribute("aria-label")).toBe("Switch to dark theme");
	});

	it("keeps its label across a re-translation", () => {
		renderThemeToggle(btn, "light");
		applyDomTranslations(document);
		expect(btn.getAttribute("title")).toBe("Switch to dark theme");
	});
});
