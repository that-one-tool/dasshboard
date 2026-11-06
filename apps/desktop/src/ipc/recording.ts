import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeChecked } from "./invoke";

/** A session's recording stopped on its own (a failed write). */
export interface RecordingFailedEvent {
  sessionId: string;
  message: string;
}

/** Records the session's raw output into `path` (from the native save
 * dialog), replacing the file. */
export async function startRecording(sessionId: string, path: string): Promise<void> {
  await invokeChecked<void>("start_recording", { sessionId, path });
}

export async function stopRecording(sessionId: string): Promise<void> {
  await invokeChecked<void>("stop_recording", { sessionId });
}

/** Subscribes to `recording_failed` events. Returns an unlisten function. */
export function onRecordingFailed(
  handler: (event: RecordingFailedEvent) => void,
): Promise<UnlistenFn> {
  return listen<RecordingFailedEvent>("recording_failed", (e) => handler(e.payload));
}
