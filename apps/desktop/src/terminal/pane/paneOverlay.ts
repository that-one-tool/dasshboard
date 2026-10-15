/**
 * The status overlay over a pane's terminal. It keeps how to redraw what it
 * shows, so `retranslate()` can rebuild it in a new language: the states are
 * thunks that call `t()` when drawn.
 */

import { t } from "../../i18n";
import { requireEl } from "../../ui/dom";
import type { OverlayState } from "../overlay";
import { MAX_RECONNECT_ATTEMPTS } from "../reconnect";

interface OverlayEls {
  overlay: HTMLElement;
  spinner: HTMLElement;
  title: HTMLElement;
  detail: HTMLElement;
  retry: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

export class PaneOverlay {
  private readonly els: OverlayEls;
  private redraw: () => void = () => this.hide();

  constructor(root: HTMLElement) {
    this.els = {
      overlay: requireEl<HTMLElement>(root, ".pane-overlay"),
      spinner: requireEl<HTMLElement>(root, ".overlay-spinner"),
      title: requireEl<HTMLElement>(root, ".overlay-title"),
      detail: requireEl<HTMLElement>(root, ".overlay-detail"),
      retry: requireEl<HTMLButtonElement>(root, ".overlay-retry"),
      cancel: requireEl<HTMLButtonElement>(root, ".overlay-cancel"),
    };
  }

  show(makeState: () => OverlayState): void {
    this.drawWith(() => this.drawState(makeState()));
  }

  /** Auto-reconnect attempt `attempt` of the budget, with Cancel. */
  showReconnecting(attempt: number): void {
    this.drawWith(() => this.drawReconnecting(attempt));
  }

  hide(): void {
    this.redraw = () => this.hide();
    this.els.overlay.classList.add("dialog-hidden");
  }

  retranslate(): void {
    this.redraw();
  }

  private drawWith(draw: () => void): void {
    this.redraw = draw;
    draw();
  }

  private drawState(state: OverlayState): void {
    const { overlay, spinner, title, detail, retry, cancel } = this.els;
    overlay.classList.toggle("dialog-hidden", !state.visible);
    overlay.classList.toggle("overlay-error", state.variant === "error");
    spinner.hidden = !state.showSpinner;
    title.textContent = state.title;
    detail.textContent = state.detail;
    retry.hidden = !state.showRetry;
    cancel.hidden = true;
  }

  private drawReconnecting(attempt: number): void {
    const { overlay, spinner, title, detail, retry, cancel } = this.els;
    overlay.classList.remove("dialog-hidden", "overlay-error");
    spinner.hidden = false;
    title.textContent = t("pane.overlay.reconnecting");
    detail.textContent = t("pane.overlay.attempt", { n: attempt, max: MAX_RECONNECT_ATTEMPTS });
    retry.hidden = true;
    cancel.hidden = false;
  }
}
