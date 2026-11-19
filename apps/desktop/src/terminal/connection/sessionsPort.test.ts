import { describe, it, expect, vi } from "vitest";

vi.mock("../../ipc", () => ({
  connect: vi.fn(async (sessionId: string) => sessionId),
  disconnect: vi.fn(async () => {}),
  readOutput: vi.fn(async () => ({ start: 0, bytes: new Uint8Array(), end: true })),
  writeStdin: vi.fn(async () => {}),
  writeStdinBinary: vi.fn(async () => {}),
  resizePty: vi.fn(async () => {}),
  onSessionStatus: vi.fn(async () => () => {}),
}));

import { ipcSessionsPort } from "./sessionsPort";
import {
  connect,
  disconnect,
  onSessionStatus,
  readOutput,
  resizePty,
  writeStdin,
  writeStdinBinary,
} from "../../ipc";

describe("ipcSessionsPort", () => {
  it("forwards each session call to its IPC command", async () => {
    await ipcSessionsPort.connect("s1", "dev-1", 80, 24, "/rec.log");
    await ipcSessionsPort.disconnect("s1");
    await ipcSessionsPort.readOutput("s1", 7);
    await ipcSessionsPort.writeStdin("s1", "ls");
    await ipcSessionsPort.writeStdinBinary("s1", "\x1b");
    await ipcSessionsPort.resizePty("s1", 100, 30);
    const handler = (): void => {};
    await ipcSessionsPort.onSessionStatus(handler);

    expect(connect).toHaveBeenCalledWith("s1", "dev-1", 80, 24, "/rec.log");
    expect(disconnect).toHaveBeenCalledWith("s1");
    expect(readOutput).toHaveBeenCalledWith("s1", 7);
    expect(writeStdin).toHaveBeenCalledWith("s1", "ls");
    expect(writeStdinBinary).toHaveBeenCalledWith("s1", "\x1b");
    expect(resizePty).toHaveBeenCalledWith("s1", 100, 30);
    expect(onSessionStatus).toHaveBeenCalledWith(handler);
  });

  it("picks a fresh session id each time", () => {
    expect(ipcSessionsPort.newSessionId()).not.toBe(ipcSessionsPort.newSessionId());
  });
});
