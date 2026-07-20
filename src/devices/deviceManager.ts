/**
 * Device manager UI: sidebar device list, add/edit/delete dialogs.
 *
 * This module handles the DOM structure and event binding for device management.
 * State and validation logic are kept in separate modules for testability.
 */

import type { Device, Auth, AppError } from "../ipc";
import {
  listDevices,
  saveDevice,
  deleteDevice,
  testConnection,
  exportDevices,
  importDevices,
} from "../ipc";
import { validateDevice } from "./validation";
import { decideSecretToSend } from "./savePayload";
import { confirm } from "../ui/confirm";
import { pickJsonSavePath, pickJsonOpenPath } from "../ui/fileDialog";
import { pencilIcon, trashIcon } from "../ui/icons";

export interface DeviceManagerOptions {
  onError?: (error: AppError) => void;
  onSuccess?: (message: string) => void;
}

/**
 * Initializes the device manager UI: sidebar with device list and dialogs.
 */
export function initDeviceManager(options: DeviceManagerOptions = {}): void {
  const deviceListEl = document.querySelector<HTMLElement>(".device-list");
  if (!deviceListEl) return;

  const manager = new DeviceManagerImpl(deviceListEl, options);
  manager.init();
}

/**
 * Looks up a required `<input>` by selector, throwing a clear error if it is
 * missing instead of silently asserting past `strict` null-checking with an
 * `as HTMLInputElement` cast. Every field queried through this helper is part
 * of the static dialog markup rendered by `renderUI()`, so a miss means the
 * markup and the code have drifted — which should fail loudly rather than
 * become a runtime `Cannot read properties of null`.
 */
function requireInput(root: ParentNode, selector: string): HTMLInputElement {
  const el = root.querySelector<HTMLInputElement>(selector);
  if (!el) {
    throw new Error(`Expected input element not found: ${selector}`);
  }
  return el;
}

export class DeviceManagerImpl {
  private container: HTMLElement;
  private options: DeviceManagerOptions;
  private devices: Device[] = [];
  private editingDeviceId: string | null = null;

  constructor(container: HTMLElement, options: DeviceManagerOptions) {
    this.container = container;
    this.options = options;
  }

  async init(): Promise<void> {
    this.renderUI();
    await this.loadDevices();
  }

  private renderUI(): void {
    this.container.innerHTML = `
      <div class="device-manager">
        <div class="device-list-header">
          <h2>Devices</h2>
          <button class="btn btn-primary device-add-btn" title="Add device">
            +
          </button>
        </div>
        <div class="section-actions">
          <button
            class="btn btn-small device-export-btn"
            data-action="export"
            title="Export devices to a JSON file"
          >
            Export
          </button>
          <button
            class="btn btn-small device-import-btn"
            data-action="import"
            title="Import devices from a JSON file"
          >
            Import
          </button>
        </div>
        <div class="device-list-items"></div>
      </div>
      <div id="device-dialog" class="dialog dialog-hidden" aria-hidden="true">
        <div class="dialog-overlay" data-close-dialog></div>
        <div class="dialog-content">
          <div class="dialog-header">
            <h2 id="device-dialog-title">Add Device</h2>
            <button class="dialog-close-btn" data-close-dialog aria-label="Close">
              &times;
            </button>
          </div>
          <form id="device-form" class="device-form">
            <div class="form-group">
              <label for="device-name">Name</label>
              <input id="device-name" type="text" placeholder="My Server" />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-host">Host</label>
              <input id="device-host" type="text" placeholder="192.168.1.10" />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-port">Port</label>
              <input
                id="device-port"
                type="number"
                placeholder="22"
                min="1"
                max="65535"
              />
              <span class="error-text"></span>
            </div>

            <div class="form-group">
              <label for="device-username">Username</label>
              <input
                id="device-username"
                type="text"
                placeholder="admin"
                autocomplete="off"
              />
              <span class="error-text"></span>
            </div>

            <fieldset class="form-fieldset">
              <legend>Authentication</legend>
              <div class="form-group">
                <label>
                  <input
                    type="radio"
                    name="auth-method"
                    value="password"
                    checked
                  />
                  Password
                </label>
                <label>
                  <input type="radio" name="auth-method" value="key" />
                  Key
                </label>
              </div>
            </fieldset>

            <div id="auth-password" class="auth-method-section">
              <div class="form-group">
                <label for="device-secret">Secret</label>
                <input
                  id="device-secret"
                  type="password"
                  placeholder="unchanged"
                />
                <span class="error-text"></span>
              </div>
            </div>

            <div id="auth-key" class="auth-method-section auth-method-hidden">
              <div class="form-group">
                <label for="device-key-path">Key Path</label>
                <input id="device-key-path" type="text" placeholder="" />
                <span class="error-text"></span>
              </div>
              <div class="form-group">
                <label for="device-passphrase">Passphrase (optional)</label>
                <input id="device-passphrase" type="password" placeholder="" />
                <span class="error-text"></span>
              </div>
            </div>

            <div class="form-group form-group-checkbox">
              <label for="device-auto-reconnect">
                <input id="device-auto-reconnect" type="checkbox" />
                Auto-reconnect on unexpected disconnect
              </label>
            </div>

            <div class="form-actions">
              <button
                type="button"
                class="btn btn-secondary btn-test-connection"
              >
                Test connection
              </button>
              <button type="submit" class="btn btn-primary">Save</button>
              <button type="button" class="btn btn-secondary" data-close-dialog>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    `;

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

    // Dialog close buttons
    this.container.querySelectorAll("[data-close-dialog]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (e.target === btn) {
          this.closeDialog();
        }
      });
    });

    // Auth method radio buttons
    const authRadios = this.container.querySelectorAll<HTMLInputElement>(
      'input[name="auth-method"]',
    );
    authRadios.forEach((radio) => {
      radio.addEventListener("change", () => this.updateAuthMethodDisplay());
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

  private updateAuthMethodDisplay(): void {
    const method = requireInput(
      this.container,
      'input[name="auth-method"]:checked',
    ).value;

    const passwordSection = this.container.querySelector("#auth-password");
    const keySection = this.container.querySelector("#auth-key");

    if (method === "password") {
      passwordSection?.classList.remove("auth-method-hidden");
      keySection?.classList.add("auth-method-hidden");
    } else {
      passwordSection?.classList.add("auth-method-hidden");
      keySection?.classList.remove("auth-method-hidden");
    }
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
    this.clearSecretFields();

    if (deviceId === null) {
      // New device
      title.textContent = "Add Device";
      this.setSecretPlaceholder(false);
    } else {
      // Edit device
      const device = this.devices.find((d) => d.id === deviceId);
      if (!device) return;

      title.textContent = "Edit Device";
      this.populateFormFromDevice(device);
      this.setSecretPlaceholder(true);
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
        ? "Tests the saved credentials for this device"
        : "Save the device first, then test";
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
    this.clearSecretFields();
    this.editingDeviceId = null;
  }

  /** Blanks both secret inputs so no password/passphrase lingers in the DOM. */
  private clearSecretFields(): void {
    const secret =
      this.container.querySelector<HTMLInputElement>("#device-secret");
    const passphrase =
      this.container.querySelector<HTMLInputElement>("#device-passphrase");
    if (secret) secret.value = "";
    if (passphrase) passphrase.value = "";
  }

  private populateFormFromDevice(device: Device): void {
    const setInputValue = (selector: string, value: unknown) => {
      const el = this.container.querySelector<HTMLInputElement>(selector);
      if (el) el.value = String(value ?? "");
    };

    setInputValue("#device-name", device.name);
    setInputValue("#device-host", device.host);
    setInputValue("#device-port", device.port);
    setInputValue("#device-username", device.username);

    if (device.auth.method === "password") {
      requireInput(
        this.container,
        'input[name="auth-method"][value="password"]',
      ).checked = true;
    } else {
      requireInput(
        this.container,
        'input[name="auth-method"][value="key"]',
      ).checked = true;
      // `device.auth` is already narrowed to the `key` variant here, so
      // `keyPath` is directly accessible — no cast needed.
      setInputValue("#device-key-path", device.auth.keyPath);
    }

    const autoReconnect = this.container.querySelector<HTMLInputElement>(
      "#device-auto-reconnect",
    );
    if (autoReconnect) autoReconnect.checked = device.autoReconnect ?? false;

    this.updateAuthMethodDisplay();
  }

  private setSecretPlaceholder(isEditing: boolean): void {
    const secretInput = this.container.querySelector<HTMLInputElement>(
      "#device-secret",
    );
    const passphraseInput = this.container.querySelector<HTMLInputElement>(
      "#device-passphrase",
    );

    if (isEditing) {
      if (secretInput) secretInput.placeholder = "unchanged";
      if (passphraseInput) passphraseInput.placeholder = "unchanged";
      secretInput?.setAttribute("autocomplete", "off");
      passphraseInput?.setAttribute("autocomplete", "off");
    } else {
      if (secretInput) secretInput.placeholder = "";
      if (passphraseInput) passphraseInput.placeholder = "";
    }
  }

  private getFormValues(): Partial<Device> & { secret?: string } {
    const form = this.container.querySelector<HTMLFormElement>("#device-form");
    if (!form) return {};

    const authMethod = requireInput(
      form,
      'input[name="auth-method"]:checked',
    ).value;
    const secret = requireInput(form, "#device-secret").value;

    let auth: Auth;
    if (authMethod === "password") {
      auth = { method: "password" };
    } else {
      const keyPath = requireInput(form, "#device-key-path").value;
      auth = { method: "key", keyPath };
    }

    return {
      id: this.editingDeviceId ?? "",
      name: requireInput(form, "#device-name").value,
      host: requireInput(form, "#device-host").value,
      port: parseInt(requireInput(form, "#device-port").value, 10),
      username: requireInput(form, "#device-username").value,
      auth,
      autoReconnect: requireInput(form, "#device-auto-reconnect").checked,
      secret,
    };
  }

  private clearFieldErrors(): void {
    this.container
      .querySelectorAll(".form-group .error-text")
      .forEach((el) => {
        el.textContent = "";
      });
  }

  private displayFieldErrors(
    errors: Array<{ field: string; message: string }>,
  ): void {
    this.clearFieldErrors();
    errors.forEach(({ field, message }) => {
      const input = this.container.querySelector<HTMLInputElement>(
        `#device-${field.replace(/([A-Z])/g, "-$1").toLowerCase()}`,
      );
      if (input) {
        const errorEl = input.closest(".form-group")?.querySelector(".error-text");
        if (errorEl) errorEl.textContent = message;
      }
    });
  }

  private async handleFormSubmit(e: Event): Promise<void> {
    e.preventDefault();

    const values = this.getFormValues();

    // Client-side validation
    const errors = validateDevice(values as Partial<Device>);
    if (errors.length > 0) {
      this.displayFieldErrors(errors);
      return;
    }

    try {
      const isNewDevice = this.editingDeviceId === null;
      const secretToSend = decideSecretToSend(isNewDevice, values.secret ?? "");

      const device = values as Device;
      await saveDevice(device, secretToSend);

      this.options.onSuccess?.("Device saved");
      this.closeDialog();
      await this.loadDevices();
    } catch (err) {
      const error = err as AppError;
      this.displayFieldErrors([
        { field: "general", message: error.message },
      ]);
      this.options.onError?.(error);
    }
  }

  private async handleTestConnection(): Promise<void> {
    if (this.editingDeviceId === null) return;
    const btn = this.container.querySelector<HTMLButtonElement>(
      ".btn-test-connection",
    );
    const original = btn?.textContent ?? "Test connection";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Testing…";
    }
    try {
      // A first-contact host key raises a `host_key_prompt`, handled by the
      // global host-key dialog; on accept the test proceeds.
      await testConnection(this.editingDeviceId);
      this.options.onSuccess?.("Connection succeeded");
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
      this.options.onSuccess?.(`Exported ${count} device(s)`);
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
      this.options.onSuccess?.(`Imported ${count} device(s)`);
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
      listItems.innerHTML =
        '<div class="empty-state">No devices yet.<br />Click <strong>+ Add</strong> above to create your first one.</div>';
      return;
    }

    listItems.innerHTML = this.devices
      .map(
        (device) => `
      <div class="device-item">
        <div class="device-info">
          <div class="device-name">${escapeHtml(device.name)}</div>
          <div class="device-host">${escapeHtml(device.host)}:${device.port}</div>
        </div>
        <div class="device-actions">
          <button
            class="btn btn-icon btn-edit"
            data-device-id="${escapeHtml(device.id)}"
            title="Edit device"
            aria-label="Edit device"
          >
            ${pencilIcon}
          </button>
          <button
            class="btn btn-icon btn-danger btn-delete"
            data-device-id="${escapeHtml(device.id)}"
            title="Delete device"
            aria-label="Delete device"
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
      `Delete "${device.name}"? This cannot be undone.`,
      { title: "Delete device?", confirmLabel: "Delete", danger: true },
    );
    if (!confirmed) return;

    try {
      await deleteDevice(deviceId);
      this.options.onSuccess?.("Device deleted");
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
