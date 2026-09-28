import { describe, it, expect } from "vitest";
import { isTerminalReply } from "./terminalReplies";

describe("isTerminalReply", () => {
  it.each([
    ["primary device attributes", "\x1b[?62;22c"],
    ["secondary device attributes", "\x1b[>0;276;0c"],
    ["cursor position report", "\x1b[24;80R"],
    ["status report", "\x1b[0n"],
    ["mode report (DECRQM)", "\x1b[?2004;1$y"],
    ["focus in", "\x1b[I"],
    ["focus out", "\x1b[O"],
    ["X10 mouse report", "\x1b[M !!"],
    ["SGR mouse press", "\x1b[<0;12;5M"],
    ["SGR mouse release", "\x1b[<0;12;5m"],
    ["OSC color reply (BEL)", "\x1b]11;rgb:0000/0000/0000\x07"],
    ["OSC color reply (ST)", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"],
    ["DCS reply", "\x1bP1$r0m\x1b\\"],
    ["window report", "\x1b[8;24;80t"],
  ])("recognizes a %s", (_name, data) => {
    expect(isTerminalReply(data)).toBe(true);
  });

  it.each([
    ["printable text", "ls -la\r"],
    ["Enter", "\r"],
    ["arrow up", "\x1b[A"],
    ["ctrl+arrow", "\x1b[1;5C"],
    ["application arrow", "\x1bOA"],
    ["F5", "\x1b[15~"],
    ["shift+tab", "\x1b[Z"],
    ["alt+x", "\x1bx"],
    ["escape", "\x1b"],
    ["pasted text", "echo hi\recho there\r"],
  ])("keeps user input: %s", (_name, data) => {
    expect(isTerminalReply(data)).toBe(false);
  });

  it("treats a modified F3 as a reply (known gap: same bytes as a cursor report)", () => {
    expect(isTerminalReply("\x1b[1;2R")).toBe(true);
  });
});
