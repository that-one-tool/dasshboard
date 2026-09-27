/**
 * @vitest-environment happy-dom
 *
 * The resizable left menu: a restored width (clamped to the 20rem minimum), the
 * CSS default until first resized, and a maximum that always leaves the
 * terminal grid at least 24rem — room for the tab strip's action buttons and
 * one tab (so it accounts for an open Files panel, which
 * sits outside the grid). happy-dom has no layout, so element widths are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initSidebarResize, type SidebarResizeOptions } from "./sidebarResize";

let sidebar: HTMLElement;
let handle: HTMLElement;
let paneRoot: HTMLElement;

function stubWidth(el: HTMLElement, width: number): void {
	el.getBoundingClientRect = () => ({ width }) as DOMRect;
}

function init(overrides: Partial<SidebarResizeOptions> = {}) {
	const opts: SidebarResizeOptions = {
		sidebar,
		handle,
		paneRoot,
		onLayoutChange: vi.fn(),
		onPersist: vi.fn(),
		...overrides,
	};
	return { resize: initSidebarResize(opts), opts };
}

const key = (k: string, shiftKey = false): void => {
	handle.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
};

beforeEach(() => {
	document.body.innerHTML = `
    <aside class="sidebar"></aside>
    <div class="sidebar-splitter" tabindex="0"></div>
    <div id="pane-root"></div>`;
	sidebar = document.querySelector<HTMLElement>(".sidebar") as HTMLElement;
	handle = document.querySelector<HTMLElement>(".sidebar-splitter") as HTMLElement;
	paneRoot = document.querySelector<HTMLElement>("#pane-root") as HTMLElement;
	stubWidth(sidebar, 320);
	stubWidth(paneRoot, 800);
});

describe("initSidebarResize", () => {
	it("leaves the CSS default in place until the menu is resized", () => {
		const { resize } = init();
		expect(sidebar.style.width).toBe("");
		expect(resize.persistedWidth()).toBeUndefined();
	});

	it("restores a saved width", () => {
		const { resize } = init({ initialWidth: 400 });
		expect(sidebar.style.width).toBe("400px");
		expect(resize.persistedWidth()).toBe(400);
	});

	it("never restores below the 20rem minimum", () => {
		const { resize } = init({ initialWidth: 100 });
		expect(sidebar.style.width).toBe("320px");
		expect(resize.persistedWidth()).toBe(320);
	});

	it("re-limits a saved width that no longer fits the window", () => {
		stubWidth(paneRoot, 420); // max = 320 + 420 - 384 = 356
		const { resize } = init({ initialWidth: 900 });
		expect(sidebar.style.width).toBe("356px");
		expect(resize.persistedWidth()).toBe(356);
	});

	it("resizes live, refits the layout, and persists the new width", () => {
		const { resize, opts } = init();
		key("ArrowRight");
		expect(sidebar.style.width).toBe("336px");
		expect(opts.onLayoutChange).toHaveBeenCalled();
		expect(opts.onPersist).toHaveBeenCalledTimes(1);
		expect(resize.persistedWidth()).toBe(336);
	});

	it("keeps at least 24rem for the terminal grid (the top bar fits)", () => {
		stubWidth(paneRoot, 420); // room to grow: 420 - 384 = 36px
		init();
		key("ArrowRight", true); // +64px requested
		expect(sidebar.style.width).toBe("356px");
	});

	it("does not shrink below the minimum", () => {
		init();
		key("ArrowLeft");
		expect(sidebar.style.width).toBe("320px");
	});
});
