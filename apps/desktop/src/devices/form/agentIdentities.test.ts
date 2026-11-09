/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AgentIdentityInfo } from "../../ipc";
import { clearAgentIdentities, populateAgentIdentities } from "./agentIdentities";

let root: HTMLElement;

function select(): HTMLSelectElement {
  return root.querySelector<HTMLSelectElement>("#device-agent-identity")!;
}

function identity(fingerprint: string, extra: Partial<AgentIdentityInfo> = {}): AgentIdentityInfo {
  return { fingerprint, comment: "", algorithm: "ssh-ed25519", isCertificate: false, isSecurityKey: false, ...extra } as AgentIdentityInfo;
}

beforeEach(() => {
  root = document.createElement("div");
  root.innerHTML = `<select id="device-agent-identity"></select><span id="device-agent-status">3 keys</span>`;
});

describe("populateAgentIdentities", () => {
  it("labels each identity by comment (else algorithm), marking security keys", () => {
    populateAgentIdentities(root, [
      identity("SHA256:a", { comment: "work" }),
      identity("SHA256:b", { isSecurityKey: true }),
    ]);
    expect([...select().options].map((o) => o.textContent)).toEqual([
      "work — SHA256:a",
      "🔑 ssh-ed25519 — SHA256:b",
    ]);
  });

  it("keeps the current selection across a refresh", () => {
    populateAgentIdentities(root, [identity("SHA256:a"), identity("SHA256:b")]);
    select().value = "SHA256:b";
    populateAgentIdentities(root, [identity("SHA256:a"), identity("SHA256:b")]);
    expect(select().value).toBe("SHA256:b");
  });

  it("keeps a saved fingerprint the agent no longer lists, marked as missing", () => {
    populateAgentIdentities(root, [identity("SHA256:a")], "SHA256:gone");
    expect(select().value).toBe("SHA256:gone");
    expect(select().options[0]?.value).toBe("SHA256:a");
    expect(select().options[1]?.textContent).toContain("not currently in the agent");
  });

  it("does nothing without the picker", () => {
    root.innerHTML = "";
    expect(() => populateAgentIdentities(root, [identity("x")])).not.toThrow();
  });
});

describe("clearAgentIdentities", () => {
  it("empties the picker and its status", () => {
    populateAgentIdentities(root, [identity("SHA256:a")]);
    clearAgentIdentities(root);
    expect(select().options).toHaveLength(0);
    expect(root.querySelector("#device-agent-status")?.textContent).toBe("");
  });
});
