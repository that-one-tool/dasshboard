/**
 * The status overlay over a pane's terminal. It keeps how to redraw what it
 * shows, so `retranslate()` can rebuild it in a new language: the states are
 * thunks that call `t()` when drawn.
 */

import { t } from "../../i18n";
import { requireEl } from "../../ui/dom";
import { overlayForStatus, type OverlayState } from "../overlay";
import { MAX_RECONNECT_ATTEMPTS } from "../reconnect";
import type { Notice } from "../connection/terminalConnection";

type NoticeOf<K extends Notice["kind"]> = Extract<Notice, { kind: K }>;
type NoticeDraws = { [K in Notice["kind"]]: (overlay: PaneOverlay, notice: NoticeOf<K>) => void };

const NOTICE_DRAWS: NoticeDraws = {
  hidden: (overlay) => overlay.hide(),
  reconnecting: (overlay, notice) => overlay.showReconnecting(notice.attempt),
  status: (overlay, notice) => overlay.show(() => overlayForStatus(notice.status, notice.message)),
  deviceGone: (overlay) => overlay.show(() => overlayForStatus("error", t("pane.overlay.deviceGone"))),
  reconnectCancelled: (overlay) =>
    overlay.show(() => overlayForStatus("disconnected", t("pane.overlay.reconnectCancelled"))),
};

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

  /** What a terminal connection asks to show. */
  showNotice(notice: Notice): void {
    const draw = NOTICE_DRAWS[notice.kind] as (overlay: PaneOverlay, notice: Notice) => void;
    draw(this, notice);
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
