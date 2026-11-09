/** The confirm before closing panes that hold live sessions (grid shrink,
 * profile load over live panes, tab close). */

import { shrinkConfirmMessage } from "../gridModel";
import { t } from "../i18n";
import { confirm } from "./confirm";

export function confirmSessionTeardown(liveCount: number): Promise<boolean> {
  return confirm(shrinkConfirmMessage(liveCount), {
    title: t("grid.closeSessions.title"),
    confirmLabel: t("common.continue"),
    danger: true,
  });
}
