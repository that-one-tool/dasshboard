/**
 * A pane's output recording: the record button, and the file every session of
 * the pane records into until the user stops it (a reconnect appends).
 */

import { onRecordingFailed, startRecording, stopRecording, type RecordingFailedEvent } from "../../ipc";
import { t } from "../../i18n";
import { requireEl } from "../../ui/dom";
import { getErrorMessage } from "../../ui/errorMessage";
import { pickLogSavePath } from "../../ui/fileDialog";
import { showToast } from "../../ui/toast";
import { outputFileName } from "../scrollbackText";

export interface PaneRecordingOptions {
  /** The pane's open session, if any. */
  sessionId: () => string | null;
  ownsSession: (sessionId: string) => boolean;
  deviceName: () => string;
  onError: (message: string) => void;
}

export class PaneRecording {
  private readonly button: HTMLButtonElement;
  private path: string | null = null;
  private unlisten: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    private readonly options: PaneRecordingOptions,
  ) {
    this.button = requireEl<HTMLButtonElement>(root, ".pane-record");
    this.button.addEventListener("click", () => void this.toggle());
  }

  async listen(): Promise<void> {
    this.unlisten = await onRecordingFailed((event) => this.onFailed(event));
  }

  /** The file a new session of this pane records into, if the pane records. */
  recordTo(): string | undefined {
    return this.path ?? undefined;
  }

  /** Starting needs a session; stopping is always possible. */
  updateControls(): void {
    this.button.disabled = this.path === null && this.options.sessionId() === null;
  }

  async toggle(): Promise<void> {
    if (this.path === null) await this.start();
    else await this.stop(this.path);
  }

  private async start(): Promise<void> {
    const path = await pickLogSavePath(outputFileName(this.options.deviceName(), new Date(), "log"));
    // Read after the dialog: the session may have ended or been replaced.
    const sessionId = this.options.sessionId();
    if (path && sessionId) await this.record(sessionId, path);
  }

  private async record(sessionId: string, path: string): Promise<void> {
    try {
      await startRecording(sessionId, path);
      this.setPath(path);
      showToast(t("pane.record.started", { path }), "success");
    } catch (err) {
      this.options.onError(getErrorMessage(err));
    }
  }

  private async stop(path: string): Promise<void> {
    this.setPath(null);
    const sessionId = this.options.sessionId();
    if (sessionId) await stopRecording(sessionId).catch(() => {});
    showToast(t("pane.record.stopped", { path }), "success");
  }

  private onFailed(event: RecordingFailedEvent): void {
    if (this.path === null || !this.options.ownsSession(event.sessionId)) return;
    this.setPath(null);
    this.options.onError(t("pane.record.failed", { message: event.message }));
  }

  private setPath(path: string | null): void {
    this.path = path;
    this.render();
  }

  /** Shows the state, labelled in the current language. */
  render(): void {
    const recording = this.path !== null;
    const label = t(recording ? "pane.record.stop" : "pane.record.start");
    this.button.title = label;
    this.button.setAttribute("aria-label", label);
    this.button.setAttribute("aria-pressed", String(recording));
    this.button.classList.toggle("is-recording", recording);
    this.updateControls();
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.path = null;
  }
}
