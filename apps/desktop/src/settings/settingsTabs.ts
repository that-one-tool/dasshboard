/**
 * Tab switching for the Settings dialog (WAI-ARIA tabs pattern). Tabs are
 * `[role="tab"][data-tab]` buttons; each shows the `[data-panel]` of the same
 * name. A click or the Left/Right arrow keys (wrapping) select a tab; only the
 * selected tab sits in the Tab order (roving tabindex). `onSelect` hears the
 * selected tab's name (e.g. to refresh what its panel shows).
 */

type OnSelect = (name: string) => void;

export function wireSettingsTabs(root: HTMLElement, onSelect: OnSelect = () => {}): void {
	const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
	const selectAt = (index: number): void => {
		select(root, tabs, index);
		onSelect(tabs[index]?.dataset.tab ?? "");
	};
	tabs.forEach((tab, index) => {
		tab.addEventListener("click", () => selectAt(index));
		tab.addEventListener("keydown", (e) => onArrow(e, tabs, index, selectAt));
	});
}

function onArrow(e: KeyboardEvent, tabs: HTMLElement[], index: number, selectAt: (index: number) => void): void {
	const next = arrowTarget(e.key, index, tabs.length);
	if (next === null) return;
	e.preventDefault();
	selectAt(next);
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
