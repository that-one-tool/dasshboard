/** The device editor dialog: open it clean for a new or an existing device,
 * close it without leaving secrets behind, and read its validated values. */

import { sshAgentAvailable, type Device } from "../../ipc";
import { t } from "../../i18n";
import { createOption, listen } from "../../ui/dom";
import { deviceEndpoint } from "../deviceEndpoint";
import { clearAgentIdentities } from "../form/agentIdentities";
import {
  clearSecretFields,
  displayFieldErrors,
  setSecretPlaceholder,
  updateAuthMethodDisplay,
  updateKindDisplay,
} from "../form/formDisplay";
import { populateForm } from "../form/populateForm";
import { readFormValues } from "../form/readForm";
import { ForwardsEditor } from "../forwardsEditor";
import { validateDevice } from "../validation";

export type FormValues = ReturnType<typeof readFormValues>;

interface DialogParts {
  dialog: Element;
  title: HTMLElement;
  form: HTMLFormElement;
}

export class DeviceDialog {
  private editingDeviceId: string | null = null;
  /** The SSH "Port forwarding" sub-editor; it lives in the dialog markup. */
  private forwardsEditor: ForwardsEditor | null = null;

  constructor(private readonly container: HTMLElement) {}

  /** Wire freshly built dialog markup (call after every build). */
  attach(): void {
    const forwards = this.container.querySelector<HTMLElement>("#device-forwards");
    if (forwards) this.forwardsEditor = new ForwardsEditor(forwards);
    this.wireCloseButtons();
    listen(this.container, "#device-kind", "change", () => updateKindDisplay(this.container));
    this.container.querySelectorAll<HTMLInputElement>('input[name="auth-method"]').forEach((radio) => {
      radio.addEventListener("change", () => updateAuthMethodDisplay(this.container));
    });
    // Escape closes the dialog (keyboard parity with the shared modals).
    listen(this.container, "#device-dialog", "keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  /** Opens the dialog for `deviceId` (`null` = a new device) from `devices`. */
  open(deviceId: string | null, devices: Device[]): void {
    this.editingDeviceId = deviceId;
    const parts = this.findParts();
    if (!parts) return;
    this.resetForm(parts.form, deviceId, devices);
    if (!this.fillForm(parts.title, deviceId, devices)) return;
    this.show(parts.dialog);
  }

  close(): void {
    const dialog = this.container.querySelector("#device-dialog");
    if (dialog) hide(dialog);
    // Never let secret material linger in the DOM after the dialog closes,
    // whether it was closed via Save, Cancel, the ✕, or the overlay.
    clearSecretFields(this.container);
    this.editingDeviceId = null;
    this.forwardsEditor?.setForwards([]);
  }

  /** The form's values, or null once their errors are shown. SSH forwards are
   * validated by their sub-editor, which marks each offending row inline. */
  readValidValues(): FormValues | null {
    const values = this.readValues();
    const errors = validateDevice(values);
    displayFieldErrors(this.container, errors);
    const forwardsOk = this.validateForwards(values.kind);
    return errors.length === 0 && forwardsOk ? values : null;
  }

  private readValues(): FormValues {
    const forwards = this.forwardsEditor?.getForwards() ?? [];
    return readFormValues(this.container, this.editingDeviceId, forwards);
  }

  private validateForwards(kind: FormValues["kind"]): boolean {
    if (kind !== "ssh" || !this.forwardsEditor) return true;
    return this.forwardsEditor.validate();
  }

  private wireCloseButtons(): void {
    this.container.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", (e) => {
        if (e.target === button) this.close();
      });
    });
  }

  private findParts(): DialogParts | null {
    const dialog = this.container.querySelector("#device-dialog");
    const titleAndForm = this.findTitleAndForm();
    return dialog && titleAndForm ? { dialog, ...titleAndForm } : null;
  }

  private findTitleAndForm(): Omit<DialogParts, "dialog"> | null {
    const title = this.container.querySelector<HTMLElement>("#device-dialog-title");
    const form = this.container.querySelector<HTMLFormElement>("#device-form");
    return title && form ? { title, form } : null;
  }

  /**
   * Always start from a fully clean form, for both the new and edit paths, so
   * a secret typed for one device and then cancelled can't be saved against
   * the next one (SPEC §7, §8). `form.reset()` restores the markup defaults;
   * `clearSecretFields` keeps the empty-field ⇒ omit-secret rule of
   * `decideSecretToSend` true. Forwards start empty for the same reason.
   */
  private resetForm(form: HTMLFormElement, deviceId: string | null, devices: Device[]): void {
    form.reset();
    clearSecretFields(this.container);
    clearAgentIdentities(this.container);
    updateKindDisplay(this.container);
    this.forwardsEditor?.setForwards([]);
    // Before `populateForm`, so the edit path can select the saved jump host.
    populateProxyJumpOptions(this.container, devices, deviceId);
  }

  /** Fills the form for a new or an existing device; false when the device is gone. */
  private fillForm(title: HTMLElement, deviceId: string | null, devices: Device[]): boolean {
    if (deviceId === null) return this.fillNew(title);
    const device = devices.find((d) => d.id === deviceId);
    return device ? this.fillExisting(title, device) : false;
  }

  private fillNew(title: HTMLElement): boolean {
    title.textContent = t("devices.dialog.addTitle");
    setSecretPlaceholder(this.container, false);
    return true;
  }

  private fillExisting(title: HTMLElement, device: Device): boolean {
    if (device.kind === "ssh") this.forwardsEditor?.setForwards(device.forwards);
    title.textContent = t("devices.dialog.editTitle");
    populateForm(this.container, device);
    setSecretPlaceholder(this.container, true);
    return true;
  }

  private show(dialog: Element): void {
    dialog.classList.remove("dialog-hidden");
    dialog.setAttribute("aria-hidden", "false");
    // Move focus off the trigger button behind the overlay.
    this.container.querySelector<HTMLInputElement>("#device-name")?.focus();
    void refreshAgentAvailabilityHint(this.container);
  }
}

function hide(dialog: Element): void {
  dialog.classList.add("dialog-hidden");
  dialog.setAttribute("aria-hidden", "true");
}

/** Shows the "no agent detected" hint under the forward-agent toggle when the
 * backend can't reach a local SSH agent. A failed probe hides it. */
async function refreshAgentAvailabilityHint(container: HTMLElement): Promise<void> {
  const hint = container.querySelector<HTMLElement>(".device-agent-unavailable");
  if (!hint) return;
  try {
    hint.hidden = await sshAgentAvailable();
  } catch {
    hint.hidden = true;
  }
}

/**
 * (Re)fill the ProxyJump `<select>` with the other SSH devices as candidate
 * jump hosts, after the always-present "None" (a direct connection).
 */
function populateProxyJumpOptions(container: HTMLElement, devices: Device[], editingId: string | null): void {
  const select = container.querySelector<HTMLSelectElement>("#device-proxy-jump");
  if (!select) return;
  select.innerHTML = "";
  select.appendChild(createOption("", t("devices.proxyJump.none")));
  for (const device of jumpHostCandidates(devices, editingId)) {
    select.appendChild(createOption(device.id, `${device.name} (${deviceEndpoint(device)})`));
  }
}

/** A device can't jump through itself, and serial devices can't be jump hosts. */
function jumpHostCandidates(devices: Device[], editingId: string | null): Device[] {
  return devices.filter((device) => device.kind === "ssh" && device.id !== editingId);
}
