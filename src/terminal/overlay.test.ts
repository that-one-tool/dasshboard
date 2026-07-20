import { describe, it, expect } from "vitest";
import { overlayForStatus, hostKeyDialogText } from "./overlay";
import type { HostKeyPromptEvent } from "../ipc";

describe("overlayForStatus", () => {
  it("shows a spinner and no retry while connecting", () => {
    const o = overlayForStatus("connecting");
    expect(o.visible).toBe(true);
    expect(o.variant).toBe("connecting");
    expect(o.showSpinner).toBe(true);
    expect(o.showRetry).toBe(false);
  });

  it("hides the overlay when connected", () => {
    const o = overlayForStatus("connected");
    expect(o.visible).toBe(false);
    expect(o.variant).toBe("hidden");
    expect(o.showSpinner).toBe(false);
    expect(o.showRetry).toBe(false);
  });

  it("offers Retry with the message on error", () => {
    const o = overlayForStatus("error", "boom");
    expect(o.visible).toBe(true);
    expect(o.variant).toBe("error");
    expect(o.showRetry).toBe(true);
    expect(o.detail).toBe("boom");
  });

  it("offers Retry on disconnect", () => {
    const o = overlayForStatus("disconnected");
    expect(o.visible).toBe(true);
    expect(o.showRetry).toBe(true);
    expect(o.detail).toBe("");
  });

  it("tolerates a missing message on error (empty detail)", () => {
    const o = overlayForStatus("error");
    expect(o.detail).toBe("");
  });
});

describe("hostKeyDialogText", () => {
  const base: HostKeyPromptEvent = {
    promptId: "p1",
    host: "10.0.0.5",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:abc",
    changed: false,
  };

  it("is neutral for a first-contact key", () => {
    const t = hostKeyDialogText(base);
    expect(t.danger).toBe(false);
    expect(t.heading.toLowerCase()).toContain("unknown");
    expect(t.lead).toContain("10.0.0.5:22");
  });

  it("warns loudly for a changed key", () => {
    const t = hostKeyDialogText({ ...base, changed: true });
    expect(t.danger).toBe(true);
    expect(t.heading.toLowerCase()).toContain("changed");
    expect(t.lead.toLowerCase()).toContain("intercept");
  });
});
