/**
 * Pure presentation logic for the single terminal pane (SPEC §7): mapping a
 * session status to the status-overlay it should show, and building the
 * host-key trust dialog's copy. Kept free of the DOM so it is unit-testable;
 * the thin glue in `pane.ts` / `hostKeyDialog.ts` renders the results.
 */

import type { HostKeyPromptEvent, SessionStatus } from "../ipc";

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
        title: "Connecting…",
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
        title: "Disconnected",
        detail: message ?? "",
        showSpinner: false,
        showRetry: true,
      };
    case "error":
      return {
        visible: true,
        variant: "error",
        title: "Connection error",
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
      heading: "WARNING: host key changed",
      danger: true,
      lead:
        `The host key for ${event.host}:${event.port} is different from the ` +
        `one previously trusted. This can mean the server was reinstalled — ` +
        `or that someone is intercepting the connection. Only continue if you ` +
        `know why the key changed.`,
    };
  }
  return {
    heading: "Unknown host key",
    danger: false,
    lead:
      `The authenticity of ${event.host}:${event.port} can't be established ` +
      `because this is the first connection. Verify the fingerprint below out ` +
      `of band, then choose whether to trust it.`,
  };
}
