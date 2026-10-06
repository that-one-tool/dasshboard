/**
 * @vitest-environment happy-dom
 *
 * The collapsible left menu: « collapses it to a thin bar holding » (expand)
 * and two count chips (connected devices, running port forwards);
 * Ctrl+Shift+B (Cmd+B on macOS) toggles it. The state is per-window workspace state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initSidebarRail, type SidebarRail, type SidebarRailOptions } from "./sidebarRail";
import { setLocale } from "../i18n";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

let sidebar: HTMLElement;
let splitter: HTMLElement;
let rail: SidebarRail | null = null;
let counts: { devices: number; forwards: number };

function init(overrides: Partial<SidebarRailOptions> = {}): { rail: SidebarRail; opts: SidebarRailOptions } {
	const opts: SidebarRailOptions = {
		sidebar,
		splitter,
		countDevices: vi.fn(() => counts.devices),
		countForwards: vi.fn(() => counts.forwards),
		onLayoutChange: vi.fn(),
		onPersist: vi.fn(),
		...overrides,
	};
	rail = initSidebarRail(opts);
	return { rail, opts };
}

function railEl(): HTMLElement {
	return document.querySelector<HTMLElement>(".sidebar-rail")!;
}

function expandButton(): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(".rail-expand")!;
}

function chip(kind: "devices" | "forwards"): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(`.rail-chip[data-chip="${kind}"]`)!;
}

function press(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
	window.dispatchEvent(event);
	return event;
}

/** Let the coalesced count refresh run. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	document.body.innerHTML = `
    <div class="app-content">
      <aside class="sidebar"><div class="profile-list"></div></aside>
      <div class="sidebar-splitter"></div>
    </div>`;
	sidebar = document.querySelector<HTMLElement>(".sidebar")!;
	splitter = document.querySelector<HTMLElement>(".sidebar-splitter")!;
	counts = { devices: 0, forwards: 0 };
});

afterEach(() => {
	rail?.dispose();
	rail = null;
	vi.restoreAllMocks();
});

describe("initSidebarRail", () => {
	it("starts expanded: the menu shows, the thin bar is hidden, before the menu", () => {
		const { rail } = init();
		expect(rail.isCollapsed()).toBe(false);
		expect(sidebar.hidden).toBe(false);
		expect(railEl().hidden).toBe(true);
		expect(railEl().nextElementSibling).toBe(sidebar);
		expect(rail.collapseButton.getAttribute("aria-expanded")).toBe("true");
		expect(rail.persistedCollapsed()).toBeUndefined();
	});

	it("puts « alone in a top row of the menu, above the profile list", () => {
		const { rail } = init();
		const top = sidebar.firstElementChild;
		expect(top?.classList.contains("sidebar-top")).toBe(true);
		expect(top?.children).toHaveLength(1);
		expect(top?.firstElementChild).toBe(rail.collapseButton);
	});

	it("restores a collapsed menu", () => {
		init({ initialCollapsed: true });
		expect(sidebar.hidden).toBe(true);
		expect(splitter.hidden).toBe(true);
		expect(railEl().hidden).toBe(false);
	});

	it("collapses on «, refits, persists, and moves focus to »", () => {
		const { rail, opts } = init();
		rail.collapseButton.click();

		expect(rail.isCollapsed()).toBe(true);
		expect(sidebar.hidden).toBe(true);
		expect(splitter.hidden).toBe(true);
		expect(railEl().hidden).toBe(false);
		expect(opts.onLayoutChange).toHaveBeenCalled();
		expect(opts.onPersist).toHaveBeenCalled();
		expect(rail.persistedCollapsed()).toBe(true);
		expect(document.activeElement).toBe(expandButton());
	});

	it("expands on » and moves focus back to «", () => {
		const { rail } = init({ initialCollapsed: true });
		expandButton().click();

		expect(rail.isCollapsed()).toBe(false);
		expect(sidebar.hidden).toBe(false);
		expect(splitter.hidden).toBe(false);
		expect(railEl().hidden).toBe(true);
		expect(rail.persistedCollapsed()).toBeUndefined();
		expect(document.activeElement).toBe(rail.collapseButton);
	});

	it("expands when a chip is clicked", () => {
		const { rail } = init({ initialCollapsed: true });
		chip("forwards").click();
		expect(rail.isCollapsed()).toBe(false);
	});
});

describe("count chips", () => {
	it("show the counts, dimmed at zero, with a pluralized tooltip", async () => {
		counts = { devices: 3, forwards: 0 };
		init({ initialCollapsed: true });

		expect(chip("devices").textContent?.trim()).toBe("3");
		expect(chip("devices").classList.contains("rail-chip-idle")).toBe(false);
		expect(chip("devices").title).toBe("3 connected devices");
		expect(chip("forwards").textContent?.trim()).toBe("0");
		expect(chip("forwards").classList.contains("rail-chip-idle")).toBe(true);
		expect(chip("forwards").getAttribute("aria-label")).toBe("0 running port forwards");
	});

	it("re-read both counts once per burst of refreshes", async () => {
		const { rail, opts } = init();
		vi.mocked(opts.countDevices).mockClear();
		counts = { devices: 1, forwards: 2 };

		rail.refresh();
		rail.refresh();
		await nextTask();

		expect(opts.countDevices).toHaveBeenCalledOnce();
		expect(chip("devices").textContent?.trim()).toBe("1");
		expect(chip("devices").title).toBe("1 connected device");
		expect(chip("forwards").textContent?.trim()).toBe("2");
	});

	it("follow a language change", () => {
		counts = { devices: 2, forwards: 1 };
		const { rail } = init();
		try {
			setLocale("fr");
			expect(chip("devices").title).toBe("2 appareils connectés");
			expect(rail.collapseButton.title).toBe("Réduire le menu latéral");
			expect(expandButton().title).toBe("Développer le menu latéral");
		} finally {
			setLocale("en");
		}
	});
});

describe("Ctrl+Shift+B", () => {
	const toggle = { key: "B", ctrlKey: true, shiftKey: true };

	it("toggles the menu, taking the key from the terminal", () => {
		const { rail } = init();
		const event = press(toggle);
		expect(event.defaultPrevented).toBe(true);
		expect(rail.isCollapsed()).toBe(true);
		press(toggle);
		expect(rail.isCollapsed()).toBe(false);
	});

	it("leaves plain Ctrl+B to the shell (tmux prefix, back one char)", () => {
		const { rail } = init();
		expect(press({ key: "b", ctrlKey: true }).defaultPrevented).toBe(false);
		expect(rail.isCollapsed()).toBe(false);
	});

	it("is Cmd+B on macOS, where Ctrl+Shift+B stays the terminal's", () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
		const { rail } = init();
		expect(press(toggle).defaultPrevented).toBe(false);
		expect(rail.isCollapsed()).toBe(false);
		press({ key: "b", metaKey: true });
		expect(rail.isCollapsed()).toBe(true);
	});

	it("ignores other keys and modifier mixes", () => {
		const { rail } = init();
		press({ key: "B", ctrlKey: true, shiftKey: true, altKey: true });
		press({ key: "N", ctrlKey: true, shiftKey: true });
		expect(rail.isCollapsed()).toBe(false);
	});

	it("swallows a held key without toggling again", () => {
		const { rail } = init();
		press(toggle);
		const held = press({ ...toggle, repeat: true });
		expect(held.defaultPrevented).toBe(true);
		expect(rail.isCollapsed()).toBe(true);
	});

	it("does nothing while a dialog is open", () => {
		const { rail } = init();
		document.body.insertAdjacentHTML("beforeend", `<div class="dialog confirm-dialog"></div>`);
		press(toggle);
		expect(rail.isCollapsed()).toBe(false);
	});

	it("moves focus to » when it collapses the menu around the focused element", () => {
		init();
		const search = document.createElement("input");
		sidebar.appendChild(search);
		search.focus();

		press(toggle);

		expect(document.activeElement).toBe(expandButton());
	});

	it("leaves focus alone when it collapses the menu from elsewhere (a terminal)", () => {
		init();
		const terminal = document.createElement("textarea");
		document.body.appendChild(terminal);
		terminal.focus();

		press(toggle);

		expect(document.activeElement).toBe(terminal);
	});

	it("stops listening once disposed, and takes its bar and top row out", () => {
		const { rail } = init();
		rail.dispose();
		press(toggle);
		expect(rail.isCollapsed()).toBe(false);
		expect(document.querySelector(".sidebar-rail")).toBeNull();
		expect(document.querySelector(".sidebar-top")).toBeNull();
	});
});
