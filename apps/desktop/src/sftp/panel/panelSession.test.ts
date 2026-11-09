import { describe, it, expect } from "vitest";
import { PanelSession } from "./panelSession";

describe("PanelSession", () => {
  it("starts disconnected with nothing picked", () => {
    const session = new PanelSession();
    expect(session.isConnected()).toBe(false);
    expect(session.shownDeviceId()).toBeNull();
    expect(session.connecting).toBe(false);
    expect(session.idleDisconnected).toBe(false);
  });

  it("tells the connected device apart, until disconnected", () => {
    const session = new PanelSession();
    session.markConnected("a");
    expect(session.isConnected()).toBe(true);
    expect(session.activeDeviceId).toBe("a");
    expect(session.isConnectedTo("a")).toBe(true);
    expect(session.isConnectedTo("b")).toBe(false);
    session.markDisconnected();
    expect(session.activeDeviceId).toBeNull();
  });

  it("shows the connected device first, else the picked one", () => {
    const session = new PanelSession();
    session.pickDevice("b");
    expect(session.selectedDeviceId).toBe("b");
    expect(session.shownDeviceId()).toBe("b");
    session.markConnected("a");
    expect(session.shownDeviceId()).toBe("a");
  });

  it("tracks a connect in flight", () => {
    const session = new PanelSession();
    session.startConnecting();
    expect(session.connecting).toBe(true);
    session.stopConnecting();
    expect(session.connecting).toBe(false);
  });

  it("remembers an idle disconnect until cleared", () => {
    const session = new PanelSession();
    session.markIdleDisconnected();
    expect(session.idleDisconnected).toBe(true);
    session.clearIdleDisconnected();
    expect(session.idleDisconnected).toBe(false);
  });
});
