/**
 * Pure presentation logic for the single terminal pane (SPEC §7): mapping a
 * session status to the status-overlay it should show, and building the
 * host-key trust dialog's copy. Kept free of the DOM so it is unit-testable;
 * the thin glue in `pane.ts` / `hostKeyDialog.ts` renders the results.
 */

import type { HostKeyPromptEvent, SessionStatus } from "../ipc";
import { t } from "../i18n";

export type OverlayVariant = "hidden" | "connecting" | "error";

export interface OverlayState {
  /** Whether the overlay is shown over the (frozen) terminal at all. */
  visible: boolean;
  variant: OverlayVariant;
  title: string;
  /** Extra detail line (e.g. the backend error message); may be empty. */
  detail: string;
  showSpinner: boolean;
  /** Whether a Retry button is offered (SPEC §7: error/disconnected). */
  showRetry: boolean;
}

/**
 * The overlay to show for a given session status. `connected` hides the
 * overlay entirely; `connecting` shows a spinner; `disconnected`/`error` show a
 * message plus a Retry affordance over the frozen terminal (SPEC §7).
 */
export function overlayForStatus(
  status: SessionStatus,
  message?: string,
): OverlayState {
  switch (status) {
    case "connecting":
      return {
        visible: true,
        variant: "connecting",
        title: t("pane.overlay.connecting"),
        detail: "",
        showSpinner: true,
        showRetry: false,
      };
    case "connected":
      return {
        visible: false,
        variant: "hidden",
        title: "",
        detail: "",
        showSpinner: false,
        showRetry: false,
      };
    case "disconnected":
      return {
        visible: true,
        variant: "error",
        title: t("pane.overlay.disconnected"),
        detail: message ?? "",
        showSpinner: false,
        showRetry: true,
      };
    case "error":
      return {
        visible: true,
        variant: "error",
        title: t("pane.overlay.error"),
        detail: message ?? "",
        showSpinner: false,
        showRetry: true,
      };
  }
}

export interface HostKeyDialogText {
  heading: string;
  /** True for a changed key: the dialog must warn loudly (possible MITM). */
  danger: boolean;
  lead: string;
}

/**
 * Copy for the host-key trust dialog. A first-contact (TOFU) key gets a neutral
 * "unknown key" prompt; a *changed* key gets a prominent warning that the
 * previously-trusted key no longer matches — a possible MITM (SPEC §6/§8).
 */
export function hostKeyDialogText(event: HostKeyPromptEvent): HostKeyDialogText {
  if (event.changed) {
    return {
      heading: t("hostkey.changed.heading"),
      danger: true,
      lead: t("hostkey.changed.lead", { host: event.host, port: event.port }),
    };
  }
  return {
    heading: t("hostkey.unknown.heading"),
    danger: false,
    lead: t("hostkey.unknown.lead", { host: event.host, port: event.port }),
  };
}
