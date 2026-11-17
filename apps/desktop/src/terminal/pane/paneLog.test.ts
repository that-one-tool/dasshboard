/**
 * A pane's lines in the diagnostic log: input stalls, lost input and unanswered output
 * reads, named by device, never with terminal data.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { logMock, warnMock } = vi.hoisted(() => ({ logMock: vi.fn(), warnMock: vi.fn() }));
vi.mock("../../ipc", () => ({ logToBackend: logMock, warnThrottled: warnMock }));

import { logInputHealth, logReadTimeout, shellLabel } from "./paneLog";

beforeEach(() => {
  logMock.mockReset();
  warnMock.mockReset();
});

describe("paneLog", () => {
  it("names a shell by its device", () => {
    expect(shellLabel("web-1")).toBe("shell web-1");
  });

  it("logs an input stall as a warning throttled per device", () => {
    logInputHealth("web-1", "stalled");
    expect(warnMock).toHaveBeenCalledWith(
      "input stall web-1",
      "shell web-1: input not responding; keys typed now are queued",
    );
  });

  it("logs the end of a stall", () => {
    logInputHealth("web-1", "ok");
    expect(logMock).toHaveBeenCalledWith("info", "shell web-1: input responding again");
  });

  it("logs input stopped for good as a warning asking to reconnect", () => {
    logInputHealth("web-1", "lost");
    expect(logMock).toHaveBeenCalledWith("warn", "shell web-1: input stopped: reconnect");
  });

  it("logs unanswered reads throttled per device", () => {
    logReadTimeout("web-1", 3);
    expect(warnMock).toHaveBeenCalledWith("read timeout web-1", "shell web-1: output read unanswered (3 in a row)");
  });
});
