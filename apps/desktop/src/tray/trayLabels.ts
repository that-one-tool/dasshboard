/**
 * Keeps the system-tray menu (backend `tray.rs`) in the UI language. The
 * backend reports the live-connection count; translation and pluralization
 * stay here, so the rendered labels are pushed back on every count or locale
 * change.
 */

import {
  getLiveSessionCount,
  onLiveSessionCount,
  setTrayLabels,
  type TrayLabels,
} from "../ipc";
import { onLocaleChange, t, tp } from "../i18n";

export interface TrayLabelDeps {
  setTrayLabels: (labels: TrayLabels) => Promise<void>;
  getLiveSessionCount: () => Promise<number>;
  onLiveSessionCount: (handler: (count: number) => void) => Promise<() => void>;
  onLocaleChange: (listener: () => void) => () => void;
}

const DEFAULT_DEPS: TrayLabelDeps = {
  setTrayLabels,
  getLiveSessionCount,
  onLiveSessionCount,
  onLocaleChange,
};

/** The tray menu labels for `count` live connections, in the current locale. */
export function trayLabels(count: number): TrayLabels {
  return {
    connections: tp("tray.connections", count),
    show: t("tray.show"),
    quit: t("tray.quit"),
  };
}

/**
 * Pushes the labels now and whenever they change. The backend only emits on a
 * change, and may have done so before this listener existed (startup restores
 * sessions first), so the current count is fetched once subscribed — unless an
 * event already brought a newer one.
 */
export async function initTrayLabels(deps: TrayLabelDeps = DEFAULT_DEPS): Promise<void> {
  let count = 0;
  let eventSeen = false;
  // Best-effort: with no tray (setting off, or unsupported desktop) the labels
  // are simply kept for later, and a failed push has nothing to report.
  const push = (): void => void deps.setTrayLabels(trayLabels(count)).catch(() => {});
  deps.onLocaleChange(push);
  await deps.onLiveSessionCount((next) => {
    eventSeen = true;
    count = next;
    push();
  });
  const current = await deps.getLiveSessionCount().catch(() => count);
  if (!eventSeen) count = current;
  push();
}
