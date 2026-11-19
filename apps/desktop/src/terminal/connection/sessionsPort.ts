/**
 * The backend session calls a terminal connection makes. `ipcSessionsPort` is the
 * real adapter; tests drive the connection through a fake.
 */

import {
  connect,
  disconnect,
  onSessionStatus,
  readOutput,
  resizePty,
  writeStdin,
  writeStdinBinary,
  type OutputChunk,
  type SessionStatusEvent,
} from "../../ipc";

export interface SessionsPort {
  newSessionId(): string;
  connect(sessionId: string, deviceId: string, cols: number, rows: number, recordTo?: string): Promise<string>;
  disconnect(sessionId: string): Promise<void>;
  readOutput(sessionId: string, from: number): Promise<OutputChunk>;
  writeStdin(sessionId: string, data: string): Promise<void>;
  writeStdinBinary(sessionId: string, data: string): Promise<void>;
  resizePty(sessionId: string, cols: number, rows: number): Promise<void>;
  onSessionStatus(handler: (event: SessionStatusEvent) => void): Promise<() => void>;
}

export const ipcSessionsPort: SessionsPort = {
  newSessionId: () => crypto.randomUUID(),
  connect,
  disconnect,
  readOutput,
  writeStdin,
  writeStdinBinary,
  resizePty,
  onSessionStatus,
};
