/**
 * The collapsible left menu. « (alone in a top row of the menu, right where »
 * sits on the bar) folds it into a thin bar holding » and two count chips — connected devices and
 * running port forwards; » or a chip unfolds it, and Ctrl+Shift+B (Cmd+B on
 * macOS) toggles it. The collapsed state is per-window workspace state.
 */

import { onLocaleChange, t, tp } from "../i18n";
import { isDialogOpen, requireEl } from "../ui/dom";
import { chevronsLeftIcon, chevronsRightIcon, forwardsIcon, terminalIcon } from "../ui/icons";
import { heldModifiers, isMacPlatform, shortcutLetter } from "../ui/keyboard";

export interface SidebarRailOptions {
	sidebar: HTMLElement;
	/** The menu's resize handle, hidden along with it. */
	splitter: HTMLElement;
	initialCollapsed?: boolean;
	/** Distinct devices connected in some pane, read on every refresh. */
	countDevices: () => number;
	/** Port forwards listening, read on every refresh. */
	countForwards: () => number;
	/** The grid's width changed — refit the terminals. */
	onLayoutChange: () => void;
	/** The collapsed state changed — schedule a workspace save. */
	onPersist: () => void;
}

export interface SidebarRail {
	/** «, in the menu's top row. */
	readonly collapseButton: HTMLButtonElement;
	isCollapsed(): boolean;
	/** Re-read both counts; a burst of calls updates the chips once. */
	refresh(): void;
	/** `true` while collapsed, `undefined` otherwise (keeps the file clean). */
	persistedCollapsed(): boolean | undefined;
	dispose(): void;
}

type ChipKind = "devices" | "forwards";

const CHIP_ICONS: Record<ChipKind, string> = { devices: terminalIcon, forwards: forwardsIcon };
const CHIP_LABELS: Record<ChipKind, string> = {
	devices: "layout.rail.devices",
	forwards: "layout.rail.forwards",
};

export function initSidebarRail(opts: SidebarRailOptions): SidebarRail {
	return new Rail(opts);
}

class Rail implements SidebarRail {
	readonly collapseButton = iconButton("rail-collapse", chevronsLeftIcon);
	private readonly el = document.createElement("nav");
	private readonly expandButton = iconButton("rail-expand", chevronsRightIcon);
	private readonly chips: Record<ChipKind, HTMLButtonElement> = {
		devices: chipButton("devices"),
		forwards: chipButton("forwards"),
	};
	private readonly topRow = buildTopRow(this.collapseButton);
	private collapsed: boolean;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly stopTranslating: () => void;

	constructor(private readonly opts: SidebarRailOptions) {
		this.collapsed = opts.initialCollapsed ?? false;
		this.el.className = "sidebar-rail";
		this.el.append(this.expandButton, this.chips.devices, this.chips.forwards);
		opts.sidebar.before(this.el);
		opts.sidebar.prepend(this.topRow);
		this.collapseButton.setAttribute("aria-expanded", "true");
		this.expandButton.setAttribute("aria-expanded", "false");
		this.wireButtons();
		window.addEventListener("keydown", this.onKeyDown, true);
		this.stopTranslating = onLocaleChange(() => this.translate());
		this.applyState();
		this.translate();
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	persistedCollapsed(): boolean | undefined {
		return this.collapsed || undefined;
	}

	refresh(): void {
		if (this.refreshTimer !== null) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			this.renderChips();
		}, 0);
	}

	dispose(): void {
		window.removeEventListener("keydown", this.onKeyDown, true);
		this.stopTranslating();
		if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
		this.el.remove();
		this.topRow.remove();
	}

	private wireButtons(): void {
		this.collapseButton.addEventListener("click", () => {
			this.setCollapsed(true);
			this.expandButton.focus();
		});
		for (const button of [this.expandButton, this.chips.devices, this.chips.forwards]) {
			button.addEventListener("click", () => {
				this.setCollapsed(false);
				this.collapseButton.focus();
			});
		}
	}

	/** Capture phase, so the toggle wins over the terminal's own key handling.
	 * A held key is swallowed without toggling again. */
	private readonly onKeyDown = (e: KeyboardEvent): void => {
		if (!claimsToggle(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (!e.repeat) this.toggleFromKeyboard();
	};

	/** Collapsing hides whatever had focus in the menu (the device search, «):
	 * focus moves to » so the keyboard stays usable. */
	private toggleFromKeyboard(): void {
		const focusInMenu = this.opts.sidebar.contains(document.activeElement);
		this.setCollapsed(!this.collapsed);
		if (this.collapsed && focusInMenu) this.expandButton.focus();
	}

	private setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		this.applyState();
		this.opts.onLayoutChange();
		this.opts.onPersist();
	}

	private applyState(): void {
		this.opts.sidebar.hidden = this.collapsed;
		this.opts.splitter.hidden = this.collapsed;
		this.el.hidden = !this.collapsed;
	}

	private translate(): void {
		setLabel(this.collapseButton, t("layout.collapseSidebar"));
		setLabel(this.expandButton, t("layout.expandSidebar"));
		this.el.setAttribute("aria-label", t("layout.rail.aria"));
		this.renderChips();
	}

	private renderChips(): void {
		this.renderChip("devices", this.opts.countDevices());
		this.renderChip("forwards", this.opts.countForwards());
	}

	private renderChip(kind: ChipKind, count: number): void {
		const chip = this.chips[kind];
		setLabel(chip, tp(CHIP_LABELS[kind], count));
		chip.classList.toggle("rail-chip-idle", count === 0);
		requireEl<HTMLElement>(chip, ".rail-chip-count").textContent = String(count);
	}
}

/** The toggle key, unless a dialog holds the keyboard. */
function claimsToggle(e: KeyboardEvent): boolean {
	return isToggleKey(e) && !isDialogOpen();
}

/** Ctrl+Shift+B — Shift, like Ctrl+Shift+T/W/D, so the shell keeps Ctrl+B
 * (tmux's prefix, back one char) — or Cmd+B on macOS. */
function isToggleKey(e: KeyboardEvent): boolean {
	const modifiers = isMacPlatform() ? "metaKey" : "ctrlKey+shiftKey";
	return heldModifiers(e) === modifiers && shortcutLetter(e) === "b";
}

function buildTopRow(collapseButton: HTMLButtonElement): HTMLElement {
	const row = document.createElement("div");
	row.className = "sidebar-top";
	row.append(collapseButton);
	return row;
}

function iconButton(className: string, icon: string): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = `btn btn-icon ${className}`;
	button.innerHTML = icon;
	return button;
}

function chipButton(kind: ChipKind): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "rail-chip";
	button.dataset.chip = kind;
	button.innerHTML = `${CHIP_ICONS[kind]}<span class="rail-chip-count"></span>`;
	return button;
}

function setLabel(el: HTMLElement, label: string): void {
	el.title = label;
	el.setAttribute("aria-label", label);
}
