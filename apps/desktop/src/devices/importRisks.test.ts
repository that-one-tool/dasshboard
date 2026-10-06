import { describe, it, expect } from "vitest";
import { importRiskMessage, MAX_LISTED_DEVICES } from "./importRisks";
import type { DeviceRisks } from "../ipc";

function device(name: string, risks: DeviceRisks["risks"]): DeviceRisks {
  return { name, risks };
}

describe("importRiskMessage", () => {
  it("names each device with its risky settings on its own line", () => {
    const message = importRiskMessage([
      device("Build box", ["agentForwarding", "networkKeyPath"]),
      device("Tools", ["customShell"]),
    ]);

    const lines = message.split("\n");
    expect(lines.some((l) => l.includes("Build box") && l.includes("agent") && l.includes("network share"))).toBe(true);
    expect(lines.some((l) => l.includes("Tools") && l.includes("program"))).toBe(true);
  });

  it("keeps a device name with line breaks on one line", () => {
    const message = importRiskMessage([device("Evil\n• Fake: fine", ["localSnippet"])]);

    expect(message).toContain("Evil • Fake: fine");
    expect(message.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(1);
  });

  it("lists the first devices and counts the rest", () => {
    const many = Array.from({ length: MAX_LISTED_DEVICES + 3 }, (_, i) =>
      device(`Device ${i}`, ["autoStartForwards"]),
    );

    const message = importRiskMessage(many);

    expect(message).toContain(`Device ${MAX_LISTED_DEVICES - 1}`);
    expect(message).not.toContain(`Device ${MAX_LISTED_DEVICES}:`);
    expect(message).toContain("3 more");
  });
});
