import { describe, it, expect } from "vitest";
import type { SavedCommand } from "../ipc";
import { findCommandProblem, makeCommandInput, sortCommands } from "./commandText";

function command(text: string, run: boolean, name = "Name"): SavedCommand {
  return { id: "", name, text, run };
}

describe("makeCommandInput", () => {
  it("ends every line of a run command with Enter, like the connect snippet", () => {
    expect(makeCommandInput(command("cd /tmp\r\nls\n", true))).toBe("cd /tmp\rls\r");
    expect(makeCommandInput(command("uptime", true))).toBe("uptime\r");
  });

  it("types an insert-only command in as is", () => {
    expect(makeCommandInput(command("sudo systemctl restart ", false))).toBe("sudo systemctl restart ");
  });
});

describe("findCommandProblem", () => {
  it("needs a name and a command", () => {
    expect(findCommandProblem(command("ls", true, " "))).toBe("nameRequired");
    expect(findCommandProblem(command(" \n", true))).toBe("textRequired");
  });

  it("refuses control characters but tabs, mirroring the backend", () => {
    for (const text of ["uptime\u000f", "ls\u001b[201~", "a\u0003", "a\u007f", "a\u009b"]) {
      expect(findCommandProblem(command(text, true))).toBe("controlChars");
    }
    expect(findCommandProblem(command("echo\ta", false))).toBeNull();
  });

  it("allows several lines only when the command runs", () => {
    expect(findCommandProblem(command("a\nb", false))).toBe("insertOneLine");
    expect(findCommandProblem(command("a\rb", false))).toBe("insertOneLine");
    expect(findCommandProblem(command("a\nb", true))).toBeNull();
  });
});

describe("sortCommands", () => {
  it("orders by name, ignoring case, without touching the input", () => {
    const input = [command("", true, "beta"), command("", true, "Alpha"), command("", true, "gamma")];
    expect(sortCommands(input).map((c) => c.name)).toEqual(["Alpha", "beta", "gamma"]);
    expect(input[0]?.name).toBe("beta");
  });
});
