/**
 * The long-lived views of the window, listed once in `main.ts`: a device
 * change, a config reload and a language change each go to all of them.
 */

export interface LiveView {
  /** A device was added, edited or deleted. */
  refreshDevices?: () => unknown;
  /** Config files changed on disk (another instance wrote them); defaults to
   * `refreshDevices`. */
  reloadConfig?: () => unknown;
  /** The UI language changed. */
  retranslate?: () => void;
}

export async function refreshDevicesAll(views: readonly LiveView[]): Promise<void> {
  await settleEach(views.map((view) => view.refreshDevices));
}

export async function reloadConfigAll(views: readonly LiveView[]): Promise<void> {
  await settleEach(views.map((view) => view.reloadConfig ?? view.refreshDevices));
}

export function retranslateAll(views: readonly LiveView[]): void {
  for (const view of views) view.retranslate?.();
}

/** Run every task; one failing (e.g. a transient IPC error) must not skip the
 * others. */
async function settleEach(tasks: readonly ((() => unknown) | undefined)[]): Promise<void> {
  await Promise.allSettled(tasks.map(async (task) => task?.()));
}
