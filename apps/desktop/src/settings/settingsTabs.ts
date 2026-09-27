/**
 * Tab switching for the Settings dialog (WAI-ARIA tabs pattern). Tabs are
 * `[role="tab"][data-tab]` buttons; each shows the `[data-panel]` of the same
 * name. A click or the Left/Right arrow keys (wrapping) select a tab; only the
 * selected tab sits in the Tab order (roving tabindex).
 */

export function wireSettingsTabs(root: HTMLElement): void {
	const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
	tabs.forEach((tab, index) => {
		tab.addEventListener("click", () => select(root, tabs, index));
		tab.addEventListener("keydown", (e) => onArrow(e, root, tabs, index));
	});
}

function onArrow(e: KeyboardEvent, root: HTMLElement, tabs: HTMLElement[], index: number): void {
	const next = arrowTarget(e.key, index, tabs.length);
	if (next === null) return;
	e.preventDefault();
	select(root, tabs, next);
	tabs[next]?.focus();
}

function arrowTarget(key: string, index: number, count: number): number | null {
	if (key === "ArrowRight") return (index + 1) % count;
	if (key === "ArrowLeft") return (index - 1 + count) % count;
	return null;
}

function select(root: HTMLElement, tabs: HTMLElement[], index: number): void {
	tabs.forEach((tab, i) => setTabState(root, tab, i === index));
}

function setTabState(root: HTMLElement, tab: HTMLElement, selected: boolean): void {
	tab.setAttribute("aria-selected", String(selected));
	tab.tabIndex = selected ? 0 : -1;
	const panel = root.querySelector<HTMLElement>(`[data-panel="${tab.dataset.tab}"]`);
	if (panel) panel.hidden = !selected;
}
