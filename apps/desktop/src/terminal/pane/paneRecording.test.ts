/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RecordingFailedEvent } from "../../ipc";

const h = vi.hoisted(() => ({
  failedHandler: null as ((e: RecordingFailedEvent) => void) | null,
  unlisten: vi.fn(),
}));

vi.mock("../../ipc", () => ({
  startRecording: vi.fn(async () => {}),
  stopRecording: vi.fn(async () => {}),
  onRecordingFailed: vi.fn(async (handler: (e: RecordingFailedEvent) => void) => {
    h.failedHandler = handler;
    return h.unlisten;
  }),
}));

const pickLogSavePathMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "/home/me/rec.log"));
vi.mock("../../ui/fileDialog", () => ({ pickLogSavePath: pickLogSavePathMock }));

const showToastMock = vi.hoisted(() => vi.fn());
vi.mock("../../ui/toast", () => ({ showToast: showToastMock }));

import { startRecording, stopRecording } from "../../ipc";
import { setLocale, t } from "../../i18n";
import { paneMarkup } from "./paneTemplate";
import { PaneRecording } from "./paneRecording";

describe("PaneRecording", () => {
  let root: HTMLElement;
  let sessionId: string | null;
  let onError: ReturnType<typeof vi.fn<(message: string) => void>>;
  let recording: PaneRecording;

  const button = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>(".pane-record")!;
  const click = (): Promise<void> => recording.toggle();

  beforeEach(async () => {
    vi.clearAllMocks();
    pickLogSavePathMock.mockResolvedValue("/home/me/rec.log");
    root = document.createElement("div");
    root.innerHTML = paneMarkup();
    sessionId = "s1";
    onError = vi.fn<(message: string) => void>();
    recording = new PaneRecording(root, {
      sessionId: () => sessionId,
      ownsSession: (id) => id === "s1" || id === "s2",
      deviceName: () => "NAS",
      onError,
    });
    await recording.listen();
  });
  afterEach(() => setLocale("en"));

  it("can't start without a session", () => {
    sessionId = null;
    recording.updateControls();
    expect(button().disabled).toBe(true);
  });

  it("starts recording the session into the picked file", async () => {
    recording.updateControls();
    expect(button().disabled).toBe(false);
    await click();
    expect(pickLogSavePathMock).toHaveBeenCalledWith(expect.stringMatching(/^NAS-.*\.log$/));
    expect(startRecording).toHaveBeenCalledWith("s1", "/home/me/rec.log");
    expect(recording.recordTo()).toBe("/home/me/rec.log");
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().classList.contains("is-recording")).toBe(true);
    expect(button().title).toBe(t("pane.record.stop"));
    expect(showToastMock).toHaveBeenCalledWith(t("pane.record.started", { path: "/home/me/rec.log" }), "success");
  });

  it("the button toggles the recording", async () => {
    recording.updateControls();
    button().click();
    await vi.waitFor(() => expect(startRecording).toHaveBeenCalled());
  });

  it("does nothing when the save dialog is cancelled", async () => {
    pickLogSavePathMock.mockResolvedValue(null);
    await click();
    expect(startRecording).not.toHaveBeenCalled();
    expect(recording.recordTo()).toBeUndefined();
  });

  it("does nothing when the session ended while the dialog was open", async () => {
    pickLogSavePathMock.mockImplementation(async () => {
      sessionId = null;
      return "/home/me/rec.log";
    });
    await click();
    expect(startRecording).not.toHaveBeenCalled();
    expect(recording.recordTo()).toBeUndefined();
  });

  it("reports a recording that could not start", async () => {
    vi.mocked(startRecording).mockRejectedValueOnce(new Error("permission denied"));
    await click();
    expect(onError).toHaveBeenCalledWith("permission denied");
    expect(recording.recordTo()).toBeUndefined();
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("stops recording the session", async () => {
    await click();
    await click();
    expect(stopRecording).toHaveBeenCalledWith("s1");
    expect(recording.recordTo()).toBeUndefined();
    expect(button().title).toBe(t("pane.record.start"));
    expect(showToastMock).toHaveBeenCalledWith(t("pane.record.stopped", { path: "/home/me/rec.log" }), "success");
  });

  it("stays stoppable while the pane has no session (reconnecting)", async () => {
    await click();
    sessionId = null;
    recording.updateControls();
    expect(button().disabled).toBe(false);
    await click();
    expect(stopRecording).not.toHaveBeenCalled();
    expect(recording.recordTo()).toBeUndefined();
  });

  it("stops and reports when one of its sessions fails to record", async () => {
    await click();
    h.failedHandler?.({ sessionId: "s2", message: "disk full" });
    expect(recording.recordTo()).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(t("pane.record.failed", { message: "disk full" }));
  });

  it("ignores another pane's failed recording", async () => {
    await click();
    h.failedHandler?.({ sessionId: "other", message: "disk full" });
    expect(recording.recordTo()).toBe("/home/me/rec.log");
    expect(onError).not.toHaveBeenCalled();
  });

  it("ignores a failure once it stopped recording", () => {
    h.failedHandler?.({ sessionId: "s1", message: "disk full" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("relabels the button in the current language", async () => {
    await click();
    setLocale("fr");
    recording.render();
    expect(button().title).toBe(t("pane.record.stop"));
    expect(button().getAttribute("aria-label")).toBe(t("pane.record.stop"));
  });

  it("stops listening when disposed", () => {
    recording.dispose();
    expect(h.unlisten).toHaveBeenCalled();
  });
});
