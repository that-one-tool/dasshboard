import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Device } from "./devices";
import type { ErrorCode } from "./errors";
import { invokeChecked, markLocalConfigWrite } from "./invoke";

/* ============================================================================
 * SSH session types & commands (SPEC section 5–6, Phase 2)
 * ============================================================================ */

export type SessionStatus =
  | "connecting"
  | "connected"
  /** Ended by the user, or the connection was lost (auto-reconnect applies). */
  | "disconnected"
  /** The shell ended on its own with exit code 0 (`exit`, `logout`): never
   * auto-reconnected. A failure code or a kill by signal is `disconnected`. */
  | "exited"
  | "error";

/** Payload of the `session_status` event (SPEC §5). */
export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;
  /** The error's code, on an `error` status (see `isRetryableFailure`). */
  code?: ErrorCode;
}

/** Payload of the `auth_prompt` event: one keyboard-interactive round. Every
 * text is the server's own. */
export interface AuthPromptEvent {
  promptId: string;
  host: string;
  port: number;
  username: string;
  name: string;
  instructions: string;
  fields: AuthPromptField[];
}

/** One answer the server asks for; `echo: false` is a hidden input. */
export interface AuthPromptField {
  label: string;
  echo: boolean;
}

/** Payload of the `host_key_prompt` event (SPEC §5–6). */
export interface HostKeyPromptEvent {
  promptId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  /** `true` when a *different* key was already trusted for this host (MITM warning). */
  changed: boolean;
  /** `true` when no key is on record because the trusted hosts were reset
   * after a damaged file: one trusted before may have changed (warning). */
  trustReset: boolean;
}

/**
 * Opens a live SSH shell session (SPEC §5). Returns the new `sessionId`; its
 * output is read with `readOutput`.
 */
export async function connect(
  sessionId: string,
  deviceId: string,
  cols: number,
  rows: number,
): Promise<string> {
  return invokeChecked<string>("connect", { sessionId, deviceId, cols, rows });
}

/** A piece of a session's output: `bytes` from offset `start` on, or `end`
 * once the session is over and all of it was read. */
export interface OutputChunk {
  start: number;
  bytes: Uint8Array;
  end: boolean;
}

/** Bytes before the data in `read_output`'s reply: the start offset (u64,
 * big-endian) and the end flag. */
const OUTPUT_HEADER = 9;

/**
 * A session's output after offset `from` (acknowledging everything before it),
 * waiting a while for some. Reading again from the same offset returns the same
 * bytes, so a failed read is simply retried.
 */
export async function readOutput(sessionId: string, from: number): Promise<OutputChunk> {
  const reply = asBuffer(await invokeChecked<ArrayBuffer | number[]>("read_output", { sessionId, from }));
  const view = new DataView(reply);
  return {
    start: Number(view.getBigUint64(0)),
    end: view.getUint8(8) === 1,
    bytes: new Uint8Array(reply, OUTPUT_HEADER),
  };
}

/** A binary command reply as bytes. Once one IPC request has failed, Tauri
 * falls back to postMessage for the rest of the page's life, and that path
 * delivers binary replies as a JSON array of numbers. */
function asBuffer(reply: ArrayBuffer | number[]): ArrayBuffer {
  return reply instanceof ArrayBuffer ? reply : Uint8Array.from(reply).buffer;
}

/** Sends keystrokes to a session (SPEC §5). */
export async function writeStdin(
  sessionId: string,
  data: string,
): Promise<void> {
  await invokeChecked<void>("write_stdin", { sessionId, data });
}

/** Writes xterm's binary input (one byte per character, e.g. legacy mouse
 * reports) to a session as those bytes, not as UTF-8 text. */
export async function writeStdinBinary(sessionId: string, data: string): Promise<void> {
  await invokeChecked<void>("write_stdin", { sessionId, data, binary: true });
}

/** Resizes a session's PTY (SPEC §5). */
export async function resizePty(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invokeChecked<void>("resize_pty", { sessionId, cols, rows });
}

/** Gracefully disconnects a session (SPEC §5). Idempotent. */
export async function disconnect(sessionId: string): Promise<void> {
  await invokeChecked<void>("disconnect", { sessionId });
}

/** Resolves a pending host-key trust prompt (SPEC §5). */
export async function respondHostKey(
  promptId: string,
  accept: boolean,
): Promise<void> {
  await invokeChecked<void>("respond_host_key", { promptId, accept });
  // Accepting a host key writes known_hosts.json; suppress the resulting
  // watcher echo. A reject changes nothing on disk, so nothing to suppress
  // (hence the conditional mark rather than `invokeMutation`).
  if (accept) markLocalConfigWrite();
}

/** Answer a keyboard-interactive prompt, one answer per field; `null` cancels. */
export async function respondAuthPrompt(
  promptId: string,
  answers: string[] | null,
): Promise<void> {
  await invokeChecked<void>("respond_auth_prompt", { promptId, answers });
}

/** Connect + authenticate + close, no shell (SPEC §5), with the device as
 * edited (saved or not). No `secret` falls back to the stored one. */
export async function testConnection(device: Device, secret?: string): Promise<void> {
  await invokeChecked<void>("test_connection", secret === undefined ? { device } : { device, secret });
}

/** Subscribes to `session_status` events. Returns an unlisten function. */
export function onSessionStatus(
  handler: (event: SessionStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionStatusEvent>("session_status", (e) => handler(e.payload));
}

/** Subscribes to `host_key_prompt` events. Returns an unlisten function. */
export function onHostKeyPrompt(
  handler: (event: HostKeyPromptEvent) => void,
): Promise<UnlistenFn> {
  return listen<HostKeyPromptEvent>("host_key_prompt", (e) =>
    handler(e.payload),
  );
}

/** Subscribes to `host_key_prompt_closed` events: the backend stopped waiting
 * on a prompt (answered, timed out, or its connection went away). */
export function onHostKeyPromptClosed(
  handler: (promptId: string) => void,
): Promise<UnlistenFn> {
  return listen<{ promptId: string }>("host_key_prompt_closed", (e) =>
    handler(e.payload.promptId),
  );
}

/** Subscribes to `auth_prompt` events: a server asks the user something
 * (a 2FA code…) while a connection authenticates. */
export function onAuthPrompt(
  handler: (event: AuthPromptEvent) => void,
): Promise<UnlistenFn> {
  return listen<AuthPromptEvent>("auth_prompt", (e) => handler(e.payload));
}

/** Subscribes to `auth_prompt_closed` events: the backend stopped waiting on
 * an auth prompt (answered, timed out, or its connection went away). */
export function onAuthPromptClosed(
  handler: (promptId: string) => void,
): Promise<UnlistenFn> {
  return listen<{ promptId: string }>("auth_prompt_closed", (e) =>
    handler(e.payload.promptId),
  );
}
