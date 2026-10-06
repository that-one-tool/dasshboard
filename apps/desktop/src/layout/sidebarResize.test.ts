/**
 * @vitest-environment happy-dom
 *
 * The resizable left menu: a restored width (clamped to the 20rem minimum), the
 * CSS default until first resized, and a maximum that always leaves the
 * terminal grid at least 28rem — room for the tab strip's action buttons and
 * a readable tab (so it accounts for an open Files panel, which
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
		stubWidth(paneRoot, 484); // max = 320 + 484 - 448 = 356
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

	it("keeps at least 28rem for the terminal grid (the top bar fits)", () => {
		stubWidth(paneRoot, 484); // room to grow: 484 - 448 = 36px
		init();
		key("ArrowRight", true); // +64px requested
		expect(sidebar.style.width).toBe("356px");
	});

	it("re-limits its width to a window that shrank, then gives it back when the window grows", () => {
		// The rendered width follows the inline one, as in a real layout.
		sidebar.getBoundingClientRect = () => ({ width: parseFloat(sidebar.style.width) }) as DOMRect;
		const { resize } = init({ initialWidth: 400 });
		stubWidth(paneRoot, 484); // max = 400 + 484 - 448 = 436
		resize.reclamp();
		expect(sidebar.style.width).toBe("400px");

		stubWidth(paneRoot, 388); // max = 400 + 388 - 448 = 340
		window.dispatchEvent(new Event("resize"));
		expect(sidebar.style.width).toBe("340px");
		expect(handle.getAttribute("aria-valuenow")).toBe("340");
		expect(resize.persistedWidth()).toBe(400);

		stubWidth(paneRoot, 800);
		window.dispatchEvent(new Event("resize"));
		expect(sidebar.style.width).toBe("400px");
	});

	it("leaves a hidden (collapsed) menu alone on a window resize", () => {
		init({ initialWidth: 400 });
		sidebar.hidden = true;
		stubWidth(sidebar, 0);
		stubWidth(paneRoot, 300);
		window.dispatchEvent(new Event("resize"));
		expect(sidebar.style.width).toBe("400px");
	});

	it("does not shrink below the minimum", () => {
		init();
		key("ArrowLeft");
		expect(sidebar.style.width).toBe("320px");
	});
});
