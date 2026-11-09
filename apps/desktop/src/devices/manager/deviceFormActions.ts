/** The device editor's buttons: Save (once at a time), Test connection with
 * the unsaved form values, and the agent-identity refresh. */

import { listAgentIdentities, saveDevice, testConnection, type AppError } from "../../ipc";
import { t, tp } from "../../i18n";
import { listen } from "../../ui/dom";
import { populateAgentIdentities } from "../form/agentIdentities";
import { buildDeviceFromForm } from "../form/buildDevice";
import { decideSecretToSend } from "../savePayload";
import type { DeviceDialog, FormValues } from "./deviceDialog";
import type { DeviceFeedback } from "./deviceFeedback";

export class DeviceFormActions {
  // A save in flight: a double-click on Save (or a second Enter) must not save
  // twice — for a new device (empty id) that created two devices.
  private saving = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly dialog: DeviceDialog,
    private readonly feedback: DeviceFeedback,
    private readonly reload: () => Promise<void>,
  ) {}

  /** Wire freshly built dialog markup (call after every build). */
  attach(): void {
    listen(this.container, "#device-agent-refresh", "click", () => void this.refreshAgentIdentities());
    listen(this.container, "#device-form", "submit", (e) => void this.submit(e));
    listen(this.container, ".btn-test-connection", "click", () => void this.test());
  }

  private async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.saving) return;
    const values = this.dialog.readValidValues();
    if (!values) return;
    this.saving = true;
    try {
      await this.save(values);
    } finally {
      this.saving = false;
    }
  }

  /** Saves, then closes the dialog and reloads the list; a failure reaches the
   * user as a toast and leaves the dialog open. */
  private async save(values: FormValues): Promise<void> {
    try {
      await saveDevice(buildDeviceFromForm(values), secretToSend(values));
      this.feedback.success(t("devices.saved"));
      this.dialog.close();
      await this.reload();
    } catch (err) {
      this.feedback.error(err);
    }
  }

  private async test(): Promise<void> {
    const values = this.dialog.readValidValues();
    if (!values) return;
    const restore = markTesting(this.container.querySelector<HTMLButtonElement>(".btn-test-connection"));
    try {
      // A first-contact host key raises a `host_key_prompt`, handled by the
      // global host-key dialog; on accept the test proceeds.
      await testConnection(buildDeviceFromForm(values), secretToSend(values));
      this.feedback.success(t("devices.test.success"));
    } catch (err) {
      this.feedback.error(err);
    } finally {
      restore();
    }
  }

  /**
   * Refresh the agent-identity picker from the live SSH agent. Keeps the
   * selected fingerprint (e.g. the saved device's), and reports a short inline
   * status (count, "none", or the agent error) beneath the picker.
   */
  private async refreshAgentIdentities(): Promise<void> {
    const button = this.container.querySelector<HTMLButtonElement>("#device-agent-refresh");
    const showStatus = statusWriter(this.container.querySelector<HTMLElement>("#device-agent-status"));
    const selected = selectedFingerprint(this.container);
    setDisabled(button, true);
    showStatus(t("devices.agent.loading"));
    try {
      // The agent-auth path can't use certificates, only bare public keys.
      const identities = (await listAgentIdentities()).filter((id) => !id.isCertificate);
      populateAgentIdentities(this.container, identities, selected);
      showStatus(identityCountText(identities.length));
    } catch (err) {
      // No agent reachable: the saved fingerprint stays selectable.
      showStatus(agentErrorText(err));
    } finally {
      setDisabled(button, false);
    }
  }
}

/** Serial/local-shell and agent-auth devices never carry a secret (SPEC §4),
 * whatever the hidden secret field holds. */
function secretToSend(values: FormValues): string | undefined {
  return decideSecretToSend(values.secret, values.kind, values.auth?.method);
}

/** Disables the Test button with a "Testing…" label; returns its restore. */
function markTesting(button: HTMLButtonElement | null): () => void {
  if (!button) return () => {};
  const original = button.textContent ?? t("devices.test");
  button.disabled = true;
  button.textContent = t("devices.test.testing");
  return () => {
    button.disabled = false;
    button.textContent = original;
  };
}

function statusWriter(status: HTMLElement | null): (text: string) => void {
  return (text) => {
    if (status) status.textContent = text;
  };
}

function selectedFingerprint(container: HTMLElement): string | undefined {
  const select = container.querySelector<HTMLSelectElement>("#device-agent-identity");
  return select?.value || undefined;
}

function setDisabled(button: HTMLButtonElement | null, disabled: boolean): void {
  if (button) button.disabled = disabled;
}

function identityCountText(count: number): string {
  return count === 0 ? t("devices.agent.empty") : tp("devices.agent.count", count);
}

function agentErrorText(err: unknown): string {
  return (err as AppError).message ?? t("devices.agent.error");
}
