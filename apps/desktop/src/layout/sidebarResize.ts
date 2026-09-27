/**
 * The resizable left menu. It keeps the CSS default (20rem) until first
 * resized; after that its width is user state, persisted per window in
 * `workspace_state.json` and restored on launch. The 20rem minimum always
 * wins; the maximum leaves the terminal grid (`#pane-root`, which excludes an
 * open Files panel) at least `MIN_GRID_REM`.
 */

import { remToPx } from "../ui/dom";
import { MIN_GRID_REM, clampWidth, wireSplitter, type WidthBounds } from "../ui/splitter";

/** Matches `.sidebar { width; min-width }` in styles.css. */
export const SIDEBAR_MIN_REM = 20;

export interface SidebarResizeOptions {
	sidebar: HTMLElement;
	handle: HTMLElement;
	paneRoot: HTMLElement;
	/** The persisted width to restore, if the menu was resized before. */
	initialWidth?: number;
	/** The layout changed (live, during a drag) — refit the terminals. */
	onLayoutChange: () => void;
	/** A resize finished — schedule a workspace save. */
	onPersist: () => void;
}

export interface SidebarResize {
	/** The width to persist, or `undefined` while the CSS default applies. */
	persistedWidth(): number | undefined;
}

export function initSidebarResize(opts: SidebarResizeOptions): SidebarResize {
	let persisted: number | undefined;
	let applied: number | undefined;
	const rendered = (): number => opts.sidebar.getBoundingClientRect().width || remToPx(SIDEBAR_MIN_REM);
	const bounds = (): WidthBounds => ({
		min: remToPx(SIDEBAR_MIN_REM),
		max: rendered() + opts.paneRoot.getBoundingClientRect().width - remToPx(MIN_GRID_REM),
	});
	const apply = (width: number): void => {
		applied = width;
		opts.sidebar.style.width = `${width}px`;
	};

	const sync = wireSplitter(opts.handle, {
		side: "start",
		currentWidth: rendered,
		bounds,
		defaultWidth: () => remToPx(SIDEBAR_MIN_REM),
		onResize: (width) => {
			apply(width);
			opts.onLayoutChange();
		},
		onCommit: () => {
			persisted = applied;
			opts.onPersist();
		},
	});

	if (opts.initialWidth !== undefined) {
		// Re-limited to the current window, which may be smaller than when saved.
		persisted = clampWidth(opts.initialWidth, bounds());
		apply(persisted);
	}
	sync();
	return { persistedWidth: () => persisted };
}
