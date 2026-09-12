/**
 * Device manager UI: sidebar device list, add/edit/delete dialogs.
 *
 * This module handles the DOM structure and event binding for device management.
 * State and validation logic are kept in separate modules for testability.
 */

import type { Device, AppError } from "../ipc";
import {
  listDevices,
  saveDevice,
  deleteDevice,
  testConnection,
  exportDevices,
  importDevices,
  importSshConfig,
} from "../ipc";
import { validateDevice } from "./validation";
import { ForwardsEditor } from "./forwardsEditor";
import { decideSecretToSend } from "./savePayload";
import { deviceEndpoint } from "./deviceEndpoint";
import { deviceManagerMarkup } from "./deviceDialogTemplate";
import {
  buildDeviceFromForm,
  clearSecretFields,
  displayFieldErrors,
  populateForm,
  readFormValues,
  setSecretPlaceholder,
  updateAuthMethodDisplay,
  updateKindDisplay,
} from "./deviceForm";
import { confirm } from "../ui/confirm";
import {
  pickJsonSavePath,
  pickJsonOpenPath,
  pickSshConfigOpenPath,
} from "../ui/fileDialog";
import { pencilIcon, trashIcon } from "../ui/icons";
import { t, tp } from "../i18n";

export interface DeviceManagerOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
}

/** Handle returned by `initDeviceManager` for driving it after construction. */
export interface DeviceManagerHandle {
  /** Re-fetches the device list from the backend and re-renders the sidebar.
   * Used by the config-reload path (multi-instance sync). */
  reload(): Promise<void>;
  /** Rebuild the sidebar + dialog markup in the current locale (language change). */
  retranslate(): void;
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
  return { reload: () => manager.reload(), retranslate: () => manager.retranslate() };
}

export class DeviceManagerImpl {
  private container: HTMLElement;
  private options: DeviceManagerOptions;
  private devices: Device[] = [];
  private editingDeviceId: string | null = null;
  /**
   * The "Port forwarding" sub-editor for the SSH device dialog. Populated on
   * open (from the device being edited, or empty for a new device) and read
   * back on save. Created once the dialog markup exists (see `render`).
   */
  private forwardsEditor: ForwardsEditor | null = null;

  constructor(container: HTMLElement, options: DeviceManagerOptions) {
    this.container = container;
    this.options = options;
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

  private renderUI(): void {
    this.container.innerHTML = deviceManagerMarkup();

    const forwardsContainer =
      this.container.querySelector<HTMLElement>("#device-forwards");
    if (forwardsContainer) {
      this.forwardsEditor = new ForwardsEditor(forwardsContainer);
    }

    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    // Add button
    this.container
      .querySelector(".device-add-btn")
      ?.addEventListener("click", () => this.openDialog(null));

    // Export / import the whole device list via native file pickers.
    this.container
      .querySelector(".device-export-btn")
      ?.addEventListener("click", () => void this.handleExport());
    this.container
      .querySelector(".device-import-btn")
      ?.addEventListener("click", () => void this.handleImport());
    this.container
      .querySelector(".device-import-ssh-btn")
      ?.addEventListener("click", () => void this.handleImportSshConfig());

    // Dialog close buttons
    this.container.querySelectorAll("[data-close-dialog]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (e.target === btn) {
          this.closeDialog();
        }
      });
    });

    // Connection-type selector (SSH vs serial): swaps which field group shows.
    this.container
      .querySelector("#device-kind")
      ?.addEventListener("change", () => updateKindDisplay(this.container));

    // Auth method radio buttons
    const authRadios = this.container.querySelectorAll<HTMLInputElement>(
      'input[name="auth-method"]',
    );
    authRadios.forEach((radio) => {
      radio.addEventListener("change", () =>
        updateAuthMethodDisplay(this.container),
      );
    });

    // Form submission
    const form = this.container.querySelector<HTMLFormElement>("#device-form");
    form?.addEventListener("submit", (e) => this.handleFormSubmit(e));

    // Test connection (uses the device's *saved* credentials).
    this.container
      .querySelector(".btn-test-connection")
      ?.addEventListener("click", () => void this.handleTestConnection());

    // Escape closes the dialog (keyboard parity with the shared modals).
    this.container
      .querySelector("#device-dialog")
      ?.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Escape") this.closeDialog();
      });
  }

  private openDialog(deviceId: string | null): void {
    this.editingDeviceId = deviceId;
    const dialog = this.container.querySelector("#device-dialog");
    const title = this.container.querySelector<HTMLElement>(
      "#device-dialog-title",
    );
    const form = this.container.querySelector<HTMLFormElement>("#device-form");

    if (!dialog || !title || !form) return;

    // Always start from a fully clean form on every open, for BOTH the new
    // and edit paths. Without this, a secret typed for one device and then
    // cancelled would survive in `#device-secret`/`#device-passphrase` and be
    // silently saved against the next device edited (SPEC §7: the secret is
    // "never pre-filled when editing"; SPEC §8: secrets must not leak between
    // devices). `form.reset()` restores every field to its markup default
    // (empty text inputs, password radio checked); `clearSecretFields()` is a
    // belt-and-suspenders guarantee that the two secret inputs are blank so
    // the empty-field ⇒ omit-secret rule in `decideSecretToSend` holds.
    form.reset();
    clearSecretFields(this.container);
    // `form.reset()` restores the kind selector to its default (SSH); reflect
    // that in which field group is shown. The edit path re-runs this from
    // `populateForm` after setting the device's actual kind.
    updateKindDisplay(this.container);

    // Start with an empty forwards list; the edit path fills it from the device
    // below. Reset here so a cancelled edit can't leak forwards into the next
    // device opened.
    this.forwardsEditor?.setForwards([]);

    if (deviceId === null) {
      // New device
      title.textContent = t("devices.dialog.addTitle");
      setSecretPlaceholder(this.container, false);
    } else {
      // Edit device
      const device = this.devices.find((d) => d.id === deviceId);
      if (!device) return;

      if (device.kind === "ssh") {
        this.forwardsEditor?.setForwards(device.forwards);
      }
      title.textContent = t("devices.dialog.editTitle");
      populateForm(this.container, device);
      setSecretPlaceholder(this.container, true);
    }

    // Test connection needs a *persisted* device (the backend looks it up by
    // id and reads its keyring secret), so it is only enabled when editing a
    // saved device. For a brand-new device the user must Save first.
    const testBtn = this.container.querySelector<HTMLButtonElement>(
      ".btn-test-connection",
    );
    if (testBtn) {
      const editingExisting = deviceId !== null;
      testBtn.disabled = !editingExisting;
      testBtn.title = editingExisting
        ? t("devices.test.enabledTitle")
        : t("devices.test.disabledTitle");
    }

    dialog.classList.remove("dialog-hidden");
    dialog.setAttribute("aria-hidden", "false");
    // Move keyboard focus into the dialog so it doesn't linger on the trigger
    // button behind the overlay.
    this.container.querySelector<HTMLInputElement>("#device-name")?.focus();
  }

  private closeDialog(): void {
    const dialog = this.container.querySelector("#device-dialog");
    dialog?.classList.add("dialog-hidden");
    dialog?.setAttribute("aria-hidden", "true");
    // Never let secret material linger in the DOM after the dialog closes,
    // whether it was closed via Save, Cancel, the ✕, or the overlay.
    clearSecretFields(this.container);
    this.editingDeviceId = null;
    this.forwardsEditor?.setForwards([]);
  }

  private async handleFormSubmit(e: Event): Promise<void> {
    e.preventDefault();

    const values = readFormValues(
      this.container,
      this.editingDeviceId,
      this.forwardsEditor?.getForwards() ?? [],
    );

    // Client-side validation. SSH forwards are validated by their sub-editor,
    // which renders errors inline on each offending row; a forward error blocks
    // the save just like a device-field error.
    const errors = validateDevice(values);
    const forwardsOk =
      values.kind === "serial" ? true : (this.forwardsEditor?.validate() ?? true);
    if (errors.length > 0 || !forwardsOk) {
      displayFieldErrors(this.container, errors);
      return;
    }

    try {
      const kind = values.kind ?? "ssh";
      // A serial save never carries a secret (SPEC §4); `decideSecretToSend`
      // enforces that regardless of the (hidden) secret field's contents.
      const secretToSend = decideSecretToSend(values.secret ?? "", kind);

      const device = buildDeviceFromForm(values);
      await saveDevice(device, secretToSend);

      this.options.onSuccess?.(t("devices.saved"));
      this.closeDialog();
      await this.loadDevices();
    } catch (err) {
      const error = err as AppError;
      // F10: no `#device-general` element exists in the dialog markup, so
      // routing a general save failure through `displayFieldErrors` was a
      // silent no-op. The toast below is the only (and sufficient) surface
      // for this error.
      this.options.onError?.(error);
    }
  }

  private async handleTestConnection(): Promise<void> {
    if (this.editingDeviceId === null) return;
    const btn = this.container.querySelector<HTMLButtonElement>(
      ".btn-test-connection",
    );
    const original = btn?.textContent ?? t("devices.test");
    if (btn) {
      btn.disabled = true;
      btn.textContent = t("devices.test.testing");
    }
    try {
      // A first-contact host key raises a `host_key_prompt`, handled by the
      // global host-key dialog; on accept the test proceeds.
      await testConnection(this.editingDeviceId);
      this.options.onSuccess?.(t("devices.test.success"));
    } catch (err) {
      const error = err as AppError;
      this.options.onError?.(error);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = original;
      }
    }
  }

  /**
   * Exports every device to a user-chosen JSON file. The backend writes the
   * file (never including secrets); a cancelled save dialog is a silent no-op.
   */
  private async handleExport(): Promise<void> {
    try {
      const path = await pickJsonSavePath("dasshboard-devices.json");
      if (path === null) return; // user cancelled the picker
      const count = await exportDevices(path);
      this.options.onSuccess?.(tp("devices.exported", count));
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /**
   * Imports devices from a user-chosen JSON file (upsert by id, backend-side).
   * Routes the success through `onSuccess` so `main.ts` also refreshes the pane
   * dropdowns and profiles, then reloads the sidebar list. Cancel is a no-op.
   */
  private async handleImport(): Promise<void> {
    try {
      const path = await pickJsonOpenPath();
      if (path === null) return; // user cancelled the picker
      const count = await importDevices(path);
      this.options.onSuccess?.(tp("devices.imported", count));
      await this.loadDevices();
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  /**
   * Imports devices from an OpenSSH client config (`~/.ssh/config` by default),
   * upserting each concrete host. Reports how many were added and, when any
   * were skipped (wildcard/`Match`-only blocks, entries missing a username, or
   * duplicates of existing devices), how many. Routes success through
   * `onSuccess` so the pane dropdowns / profiles / tunnels refresh, then reloads
   * the sidebar. Cancel is a no-op.
   */
  private async handleImportSshConfig(): Promise<void> {
    try {
      const path = await pickSshConfigOpenPath();
      if (path === null) return; // user cancelled the picker
      const { imported, skipped } = await importSshConfig(path);
      const message =
        skipped > 0
          ? tp("devices.importedSshSkipped", imported, { skipped })
          : tp("devices.importedSsh", imported);
      this.options.onSuccess?.(message);
      await this.loadDevices();
    } catch (err) {
      this.options.onError?.(err as AppError);
    }
  }

  private async loadDevices(): Promise<void> {
    try {
      this.devices = await listDevices();
      this.renderDeviceList();
    } catch (err) {
      const error = err as AppError;
      this.options.onError?.(error);
    }
  }

  private renderDeviceList(): void {
    const listItems = this.container.querySelector(".device-list-items");
    if (!listItems) return;

    if (this.devices.length === 0) {
      listItems.innerHTML = `<div class="empty-state">${t("devices.empty")}</div>`;
      return;
    }

    listItems.innerHTML = this.devices
      .map(
        (device) => `
      <div class="device-item">
        <div class="device-info">
          <div class="device-name">${escapeHtml(device.name)}</div>
          <div class="device-host">${escapeHtml(deviceEndpoint(device))}</div>
        </div>
        <div class="device-actions">
          <button
            class="btn btn-icon btn-edit"
            data-device-id="${escapeHtml(device.id)}"
            title="${t("devices.edit.aria")}"
            aria-label="${t("devices.edit.aria")}"
          >
            ${pencilIcon}
          </button>
          <button
            class="btn btn-icon btn-danger btn-delete"
            data-device-id="${escapeHtml(device.id)}"
            title="${t("devices.delete.aria")}"
            aria-label="${t("devices.delete.aria")}"
          >
            ${trashIcon}
          </button>
        </div>
      </div>
    `,
      )
      .join("");

    this.attachDeviceListeners();
  }

  private attachDeviceListeners(): void {
    this.container
      .querySelectorAll<HTMLButtonElement>(".device-item .btn-edit")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const deviceId = btn.dataset.deviceId;
          if (deviceId) this.openDialog(deviceId);
        });
      });

    this.container
      .querySelectorAll<HTMLButtonElement>(".device-item .btn-delete")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const deviceId = btn.dataset.deviceId;
          if (deviceId) this.handleDeleteDevice(deviceId);
        });
      });
  }

  private async handleDeleteDevice(deviceId: string): Promise<void> {
    const device = this.devices.find((d) => d.id === deviceId);
    if (!device) return;

    // Shared modal (Phase 6): the raw name is passed through — the dialog sets
    // it via textContent, so no manual escaping (the old native `confirm()`
    // showed HTML entities literally).
    const confirmed = await confirm(
      t("devices.delete.message", { name: device.name }),
      { title: t("devices.delete.title"), confirmLabel: t("common.delete"), danger: true },
    );
    if (!confirmed) return;

    try {
      await deleteDevice(deviceId);
      this.options.onSuccess?.(t("devices.deleted"));
      await this.loadDevices();
    } catch (err) {
      const error = err as AppError;
      this.options.onError?.(error);
    }
  }
}

/**
 * Simple HTML escape to prevent XSS.
 */
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
