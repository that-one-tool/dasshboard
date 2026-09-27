/**
 * @vitest-environment happy-dom
 *
 * The shared resize handle (left menu, Files panel): mouse drag, arrow keys
 * (Shift for bigger steps), double-click reset, bounds (the minimum wins when
 * space runs out), whole-px results (widths persist as integers), and the
 * `separator` ARIA values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { clampWidth, wireSplitter, type SplitterOptions } from "./splitter";

let handle: HTMLElement;
let width: number;
let onResize: ReturnType<typeof vi.fn<(w: number) => void>>;
let onCommit: ReturnType<typeof vi.fn<() => void>>;

function wire(side: SplitterOptions["side"], bounds = { min: 320, max: 600 }): () => void {
	return wireSplitter(handle, {
		side,
		currentWidth: () => width,
		bounds: () => bounds,
		defaultWidth: () => 320,
		onResize,
		onCommit,
	});
}

const mouse = (type: string, clientX: number, target: EventTarget = window): void => {
	target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
};
const key = (k: string, shiftKey = false): void => {
	handle.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
};

beforeEach(() => {
	document.body.innerHTML = '<div id="handle" tabindex="0"></div>';
	handle = document.querySelector<HTMLElement>("#handle") as HTMLElement;
	width = 400;
	onResize = vi.fn((w: number) => {
		width = w;
	});
	onCommit = vi.fn();
});

describe("clampWidth", () => {
	it("keeps a width inside the bounds, rounded to whole px", () => {
		expect(clampWidth(450.6, { min: 320, max: 600 })).toBe(451);
		expect(clampWidth(100, { min: 320, max: 600 })).toBe(320);
		expect(clampWidth(900, { min: 320, max: 600 })).toBe(600);
	});

	it("lets the minimum win when there is no room", () => {
		expect(clampWidth(500, { min: 320, max: 200 })).toBe(320);
	});
});

describe("wireSplitter drag", () => {
	it("widens a start-side element when dragged right, committing once at the end", () => {
		wire("start");
		mouse("mousedown", 100, handle);
		expect(handle.classList.contains("dragging")).toBe(true);
		expect(document.body.classList.contains("splitter-resizing")).toBe(true);

		mouse("mousemove", 150);
		mouse("mousemove", 160);
		expect(onResize).toHaveBeenLastCalledWith(460);
		expect(onCommit).not.toHaveBeenCalled();

		mouse("mouseup", 160);
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(handle.classList.contains("dragging")).toBe(false);
		expect(document.body.classList.contains("splitter-resizing")).toBe(false);
	});

	it("widens an end-side element when dragged left", () => {
		wire("end");
		mouse("mousedown", 500, handle);
		mouse("mousemove", 450);
		expect(onResize).toHaveBeenLastCalledWith(450);
		mouse("mouseup", 450);
	});

	it("clamps to the live bounds", () => {
		wire("start");
		mouse("mousedown", 100, handle);
		mouse("mousemove", 1000);
		expect(onResize).toHaveBeenLastCalledWith(600);
		mouse("mousemove", -1000);
		expect(onResize).toHaveBeenLastCalledWith(320);
		mouse("mouseup", 0);
	});

	it("stops following the mouse after release", () => {
		wire("start");
		mouse("mousedown", 100, handle);
		mouse("mouseup", 100);
		onResize.mockClear();
		mouse("mousemove", 300);
		expect(onResize).not.toHaveBeenCalled();
	});
});

describe("wireSplitter keyboard", () => {
	it("steps 1rem with the arrows (toward the element shrinks it) and commits each step", () => {
		wire("start");
		key("ArrowRight");
		expect(onResize).toHaveBeenLastCalledWith(416);
		key("ArrowLeft");
		expect(onResize).toHaveBeenLastCalledWith(400);
		expect(onCommit).toHaveBeenCalledTimes(2);
	});

	it("steps 4rem with Shift", () => {
		wire("start");
		key("ArrowRight", true);
		expect(onResize).toHaveBeenLastCalledWith(464);
	});

	it("mirrors the arrows for an end-side element", () => {
		wire("end");
		key("ArrowLeft");
		expect(onResize).toHaveBeenLastCalledWith(416);
	});

	it("ignores other keys", () => {
		wire("start");
		key("Enter");
		expect(onResize).not.toHaveBeenCalled();
	});
});

describe("wireSplitter reset and ARIA", () => {
	it("restores the default width on double-click", () => {
		wire("start");
		handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		expect(onResize).toHaveBeenLastCalledWith(320);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("exposes the width as separator values, synced on demand and on resize", () => {
		const sync = wire("start");
		sync();
		expect(handle.getAttribute("aria-valuenow")).toBe("400");
		expect(handle.getAttribute("aria-valuemin")).toBe("320");
		expect(handle.getAttribute("aria-valuemax")).toBe("600");

		key("ArrowRight");
		expect(handle.getAttribute("aria-valuenow")).toBe("416");
	});
});
