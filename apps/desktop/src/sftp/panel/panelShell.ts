/** The docked panel's frame: shown/hidden, collapsed to its rail, and its
 * width, dragged on the splitter beside it. Both elements live in
 * `index.html`; the splitter sits outside the panel's rebuilt markup. */

import type { SftpPanelState } from "../../ipc";
import { remToPx } from "../../ui/dom";
import { MIN_GRID_REM, wireSplitter, type WidthBounds } from "../../ui/splitter";
import { PanelLayout } from "./panelLayout";

/** The toolbar's nine icon buttons on one row: 9 × 1.875rem + 8 gaps + padding
 * + border = 22rem. Mirrored by `.sftp-panel { min-width }` in styles.css. */
const MIN_PANEL_REM = 22;
const DEFAULT_PANEL_REM = 22.5;
/** Absolute upper bound for a restored width (the live drag re-clamps against
 * the workspace row so the grid never disappears). */
const MAX_PANEL_REM = 125;

export interface ShellHooks {
  /** The panel's width changed (the terminal grid beside it must re-fit). */
  onResize: () => void;
  /** A drag or key step ended (save once, not per move). */
  onCommit: () => void;
}

export class PanelShell {
  /** The panel's own width is user state (dragged, persisted), kept in px; its
   * bounds are in rem so they scale with the root font size. */
  readonly layout = new PanelLayout(remToPx(DEFAULT_PANEL_REM));
  /** Re-syncs the splitter's ARIA width values (set once wired). */
  private syncSplitterAria = (): void => {};
  private splitterWired = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly splitter: HTMLElement | null,
    private readonly hooks: ShellHooks,
  ) {}

  /** Apply a saved state, clamping its width; `true` when it reopens the panel. */
  restore(saved: SftpPanelState): boolean {
    return this.layout.restore(saved, { min: remToPx(MIN_PANEL_REM), max: remToPx(MAX_PANEL_REM) });
  }

  /** Reflect open/collapsed/width onto the panel, the splitter and the header
   * toggle button. */
  apply(): void {
    const { layout, root } = this;
    root.hidden = !layout.isOpen();
    root.classList.toggle("sftp-collapsed", layout.isCollapsed());
    // Clear the inline width while collapsed so the `.sftp-collapsed` rail width
    // (2.5rem) applies; an inline width would otherwise override it.
    root.style.width = layout.isCollapsed() ? "" : `${layout.width()}px`;
    this.applySplitter();
    this.syncSplitterAria();
    document.querySelector("#sftp-btn")?.setAttribute("aria-pressed", String(layout.isOpen()));
  }

  /** Wire the splitter once: its listener survives a panel rebuild. */
  wireSplitter(): void {
    if (!this.splitter || this.splitterWired) return;
    this.splitterWired = true;
    this.syncSplitterAria = wireSplitter(this.splitter, {
      side: "end",
      // The rendered width: CSS `max-width` can show the panel narrower than
      // the stored width, and a drag must start from what the user sees.
      currentWidth: () => this.root.getBoundingClientRect().width || this.layout.width(),
      bounds: () => this.widthBounds(),
      defaultWidth: () => remToPx(DEFAULT_PANEL_REM),
      onResize: (width) => this.resize(width),
      onCommit: () => this.hooks.onCommit(),
    });
  }

  private applySplitter(): void {
    if (this.splitter) this.splitter.hidden = !this.layout.isOpen() || this.layout.isCollapsed();
  }

  private resize(width: number): void {
    this.layout.resize(width);
    this.root.style.width = `${width}px`;
    this.hooks.onResize();
  }

  /** `[MIN_PANEL_REM, workspace − splitter − MIN_GRID_REM]`: the grid keeps its floor. */
  private widthBounds(): WidthBounds {
    const room = widthOf(this.root.parentElement) - widthOf(this.splitter);
    return { min: remToPx(MIN_PANEL_REM), max: room - remToPx(MIN_GRID_REM) };
  }
}

function widthOf(element: Element | null): number {
  return element?.getBoundingClientRect().width ?? 0;
}
