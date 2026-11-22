/**
 * The long-lived views of the window, listed once in `main.ts`: a config
 * reload and a language change each go to all of them. Device changes reach
 * views through the device catalog (`devices/deviceCatalog.ts`) instead.
 */

export interface LiveView {
  /** Config files changed on disk (another instance wrote them). */
  reloadConfig?: () => unknown;
  /** The UI language changed. */
  retranslate?: () => void;
}

export async function reloadConfigAll(views: readonly LiveView[]): Promise<void> {
  await settleEach(views.map((view) => view.reloadConfig));
}

export function retranslateAll(views: readonly LiveView[]): void {
  for (const view of views) view.retranslate?.();
}

/** Run every task; one failing (e.g. a transient IPC error) must not skip the
 * others. */
async function settleEach(tasks: readonly ((() => unknown) | undefined)[]): Promise<void> {
  await Promise.allSettled(tasks.map(async (task) => task?.()));
}
