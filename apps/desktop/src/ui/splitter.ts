/**
 * A vertical resize handle (`role="separator"`) shared by the left menu and the
 * Files panel. Mouse drag, Left/Right arrows (Shift for a bigger step) and a
 * double-click reset all funnel through one clamp, so the bounds and the ARIA
 * values stay consistent. Widths are whole px — they are user state, persisted
 * as integers — while the step sizes and callers' bounds derive from rem.
 */

import { remToPx } from "./dom";

/** The terminal grid always keeps at least this much width when a side
 * element is resized: the tab strip above it holds the six app-action buttons,
 * the + button and at least one tab at its minimum width (~23.9rem in all),
 * plus headroom so that tab's name stays readable. */
export const MIN_GRID_REM = 28;

const KEY_STEP_REM = 1;
const KEY_STEP_LARGE_REM = 4;

export interface WidthBounds {
	min: number;
	max: number;
}

export interface SplitterOptions {
	/** Which side of the handle the resized element sits on: `start` (left, the
	 * menu) grows when dragged right, `end` (right, the Files panel) when dragged left. */
	side: "start" | "end";
	/** The element's rendered width in px — the origin of a drag or key step
	 * (a CSS cap can render it narrower than its stored width). */
	currentWidth: () => number;
	/** Live bounds in px, recomputed on every change. */
	bounds: () => WidthBounds;
	/** The width a double-click restores, in px. */
	defaultWidth: () => number;
	/** Applies a clamped width (live, during a drag). */
	onResize: (width: number) => void;
	/** A resize finished (drag end, key step, reset) — persist it. */
	onCommit: () => void;
}

/** Clamps to the bounds, rounded to whole px; the minimum wins when there is
 * no room for it. */
export function clampWidth(width: number, bounds: WidthBounds): number {
	return Math.round(Math.max(bounds.min, Math.min(bounds.max, width)));
}

/** Wires `handle`; returns a function that re-syncs its ARIA values (call it
 * after changing the width from outside, e.g. a restore). */
export function wireSplitter(handle: HTMLElement, opts: SplitterOptions): () => void {
	handle.addEventListener("mousedown", (e) => startDrag(e, handle, opts));
	handle.addEventListener("keydown", (e) => onKey(e, handle, opts));
	handle.addEventListener("dblclick", () => resizeTo(handle, opts, opts.defaultWidth(), true));
	return () => syncAria(handle, opts.currentWidth(), opts.bounds());
}

function startDrag(e: MouseEvent, handle: HTMLElement, opts: SplitterOptions): void {
	e.preventDefault();
	const startX = e.clientX;
	const startWidth = opts.currentWidth();
	const move = (m: MouseEvent): void =>
		resizeTo(handle, opts, startWidth + dragDelta(opts.side, startX, m.clientX), false);
	const end = (): void => {
		setDragging(handle, false);
		window.removeEventListener("mousemove", move);
		window.removeEventListener("mouseup", end);
		opts.onCommit();
	};
	setDragging(handle, true);
	window.addEventListener("mousemove", move);
	window.addEventListener("mouseup", end);
}

function setDragging(handle: HTMLElement, dragging: boolean): void {
	handle.classList.toggle("dragging", dragging);
	document.body.classList.toggle("splitter-resizing", dragging);
}

function dragDelta(side: SplitterOptions["side"], startX: number, x: number): number {
	return side === "start" ? x - startX : startX - x;
}

function onKey(e: KeyboardEvent, handle: HTMLElement, opts: SplitterOptions): void {
	const step = keyStep(e, opts.side);
	if (step === 0) return;
	e.preventDefault();
	resizeTo(handle, opts, opts.currentWidth() + step, true);
}

/** Px to add for an arrow key: toward the element shrinks it, away grows it. */
function keyStep(e: KeyboardEvent, side: SplitterOptions["side"]): number {
	const direction = arrowDirection(e.key);
	const grow = side === "start" ? direction : -direction;
	return grow * remToPx(e.shiftKey ? KEY_STEP_LARGE_REM : KEY_STEP_REM);
}

function arrowDirection(key: string): number {
	if (key === "ArrowRight") return 1;
	if (key === "ArrowLeft") return -1;
	return 0;
}

function resizeTo(handle: HTMLElement, opts: SplitterOptions, width: number, commit: boolean): void {
	const bounds = opts.bounds();
	const clamped = clampWidth(width, bounds);
	opts.onResize(clamped);
	syncAria(handle, clamped, bounds);
	if (commit) opts.onCommit();
}

function syncAria(handle: HTMLElement, width: number, bounds: WidthBounds): void {
	handle.setAttribute("aria-valuenow", String(Math.round(width)));
	handle.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
	handle.setAttribute("aria-valuemax", String(Math.round(Math.max(bounds.min, bounds.max))));
}
