/**
 * @vitest-environment happy-dom
 *
 * The Settings dialog's tab strip (WAI-ARIA tabs pattern): a click or the
 * Left/Right arrow keys select a tab, show its panel and hide the others; only
 * the selected tab is in the Tab order (roving tabindex).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { wireSettingsTabs } from "./settingsTabs";

function markup(): HTMLElement {
	document.body.innerHTML = `
    <div id="root">
      <div role="tablist">
        <button role="tab" data-tab="general" aria-selected="true" tabindex="0">General</button>
        <button role="tab" data-tab="connections" aria-selected="false" tabindex="-1">Connections</button>
      </div>
      <div role="tabpanel" data-panel="general">g</div>
      <div role="tabpanel" data-panel="connections" hidden>c</div>
    </div>`;
	return document.querySelector<HTMLElement>("#root") as HTMLElement;
}

const tab = (name: string): HTMLElement =>
	document.querySelector<HTMLElement>(`[data-tab="${name}"]`) as HTMLElement;
const panel = (name: string): HTMLElement =>
	document.querySelector<HTMLElement>(`[data-panel="${name}"]`) as HTMLElement;

function expectSelected(name: string, other: string): void {
	expect(tab(name).getAttribute("aria-selected")).toBe("true");
	expect(tab(name).tabIndex).toBe(0);
	expect(panel(name).hidden).toBe(false);
	expect(tab(other).getAttribute("aria-selected")).toBe("false");
	expect(tab(other).tabIndex).toBe(-1);
	expect(panel(other).hidden).toBe(true);
}

let root: HTMLElement;
beforeEach(() => {
	root = markup();
	wireSettingsTabs(root);
});

describe("wireSettingsTabs", () => {
	it("shows the clicked tab's panel", () => {
		tab("connections").click();
		expectSelected("connections", "general");

		tab("general").click();
		expectSelected("general", "connections");
	});

	it("moves with the arrow keys, wrapping, and focuses the new tab", () => {
		tab("general").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		expectSelected("connections", "general");
		expect(document.activeElement).toBe(tab("connections"));

		tab("connections").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		expectSelected("general", "connections");

		tab("general").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		expectSelected("connections", "general");
	});

	it("ignores other keys", () => {
		tab("general").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expectSelected("general", "connections");
	});
});
