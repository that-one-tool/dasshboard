/**
 * Device manager UI: sidebar device list, add/edit/delete dialogs.
 *
 * `DeviceManagerImpl` only wires its parts in `manager/`: the list, the editor
 * dialog, the editor's buttons and the import/export actions.
 */

import { deleteDevice, listDevices, type AppError, type Device } from "../ipc";
import { deviceManagerMarkup } from "./deviceDialogTemplate";
import { confirm } from "../ui/confirm";
import { listen } from "../ui/dom";
import { t } from "../i18n";
import { DeviceDialog } from "./manager/deviceDialog";
import { deviceFeedback, type DeviceFeedback } from "./manager/deviceFeedback";
import { FILE_ACTIONS, runFileAction } from "./manager/deviceFileActions";
import { DeviceFormActions } from "./manager/deviceFormActions";
import { DeviceList } from "./manager/deviceList";

export interface DeviceManagerOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
  /** Keys (`deviceGroupKey`) of the tag sections to start collapsed. */
  initialCollapsedGroups?: string[];
  /** A section was collapsed/expanded: the workspace should be saved. */
  onPersist?: () => void;
}

/** Handle returned by `initDeviceManager` for driving it after construction. */
export interface DeviceManagerHandle {
  /** Re-fetches the device list from the backend and re-renders the sidebar.
   * Used by the config-reload path (multi-instance sync). */
  reload(): Promise<void>;
  /** Rebuild the sidebar + dialog markup in the current locale (language change). */
  retranslate(): void;
  /** The collapsed tag sections to persist (undefined when none are). */
  collapsedGroups(): string[] | undefined;
}

/**
 * Initializes the device manager UI: sidebar with device list and dialogs.
 * Returns a handle whose `reload()` re-syncs the sidebar from the backend, or
 * `null` when the sidebar container is absent (nothing to manage).
 */
export function initDeviceManager(
  options: DeviceManagerOptions = {},
): DeviceManagerHandle | null {
  const deviceListEl = document.querySelector<HTMLElement>(".device-list");
  if (!deviceListEl) return null;

  const manager = new DeviceManagerImpl(deviceListEl, options);
  manager.init();
  return {
    reload: () => manager.reload(),
    retranslate: () => manager.retranslate(),
    collapsedGroups: () => manager.collapsedGroups(),
  };
}

export class DeviceManagerImpl {
  private readonly feedback: DeviceFeedback;
  private readonly list: DeviceList;
  private readonly dialog: DeviceDialog;
  private readonly formActions: DeviceFormActions;

  constructor(
    private readonly container: HTMLElement,
    options: DeviceManagerOptions,
  ) {
    this.feedback = deviceFeedback(options);
    this.list = new DeviceList(container, {
      onEdit: (id) => this.dialog.open(id, this.list.all()),
      onDelete: (id) => void this.deleteDevice(id),
      onPersist: () => options.onPersist?.(),
    }, options.initialCollapsedGroups);
    this.dialog = new DeviceDialog(container);
    this.formActions = new DeviceFormActions(container, this.dialog, this.feedback, () => this.loadDevices());
  }

  async init(): Promise<void> {
    this.renderUI();
    await this.loadDevices();
  }

  /**
   * Re-fetches the device list from the backend and re-renders the sidebar
   * (the config-reload / multi-instance-sync entry point). The static dialog
   * markup is left intact — only the list is rebuilt — so an open edit dialog
   * is undisturbed; the refreshed data is picked up the next time a dialog opens.
   */
  async reload(): Promise<void> {
    await this.loadDevices();
  }

  /**
   * Rebuild the sidebar + dialog markup in the current locale, then re-render
   * the device list (language change). Any open edit dialog is reset — a
   * language change is initiated from the settings dialog, with no device
   * dialog open — so nothing in flight is lost.
   */
  retranslate(): void {
    this.renderUI();
    void this.loadDevices();
  }

  collapsedGroups(): string[] | undefined {
    return this.list.collapsedGroups();
  }

  private renderUI(): void {
    this.container.innerHTML = deviceManagerMarkup();
    this.list.wireSearch();
    this.dialog.attach();
    this.formActions.attach();
    this.wireToolbar();
  }

  private wireToolbar(): void {
    listen(this.container, ".device-add-btn", "click", () => this.dialog.open(null, this.list.all()));
    const context = { feedback: this.feedback, reload: () => this.loadDevices() };
    for (const action of FILE_ACTIONS) {
      listen(this.container, action.selector, "click", () => void runFileAction(action, context));
    }
  }

  private async loadDevices(): Promise<void> {
    try {
      this.list.show(await listDevices());
    } catch (err) {
      this.feedback.error(err);
    }
  }

  private async deleteDevice(deviceId: string): Promise<void> {
    const device = this.list.find(deviceId);
    if (!device || !(await confirmDelete(device))) return;
    await this.removeDevice(deviceId);
  }

  private async removeDevice(deviceId: string): Promise<void> {
    try {
      await deleteDevice(deviceId);
      this.feedback.success(t("devices.deleted"));
      await this.loadDevices();
    } catch (err) {
      this.feedback.error(err);
    }
  }
}

/** The raw name goes in: the shared modal sets it as text, not markup. */
function confirmDelete(device: Device): Promise<boolean> {
  return confirm(t("devices.delete.message", { name: device.name }), {
    title: t("devices.delete.title"),
    confirmLabel: t("common.delete"),
    danger: true,
  });
}
