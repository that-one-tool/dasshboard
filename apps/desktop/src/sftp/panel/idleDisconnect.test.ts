/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IdleDisconnect } from "./idleDisconnect";
import { PanelSession } from "./panelSession";
import { PanelControls } from "./panelControls";
import { buildPanelElements } from "./panelElements";
import { DirHistory } from "./dirHistory";
import { t } from "../../i18n";

function setup(minutes = 5, hasEdits = false) {
  const els = buildPanelElements(document.createElement("aside"));
  const session = new PanelSession();
  session.markConnected("a");
  const disconnect = vi.fn(async () => {
    session.markDisconnected();
  });
  const showDisconnected = vi.fn();
  const idle = new IdleDisconnect({
    session,
    controls: new PanelControls(() => els, session, new DirHistory()),
    timeoutMinutes: () => minutes,
    hasEdits: () => hasEdits,
    disconnect,
    showDisconnected,
  });
  return { els, session, disconnect, showDisconnected, idle };
}

async function elapse(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("IdleDisconnect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("disconnects after the timeout and says why", async () => {
    const { els, session, disconnect, showDisconnected, idle } = setup();
    idle.arm();
    await elapse(5 * 60_000);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(session.idleDisconnected).toBe(true);
    expect(els.status.textContent).toBe(t("sftp.idleDisconnected"));
    expect(showDisconnected).toHaveBeenCalled();
    expect(els.connToggle.classList.contains("is-disconnected")).toBe(true);
  });

  it("never arms with a zero timeout, while disconnected, or with open edits", async () => {
    const zero = setup(0);
    zero.idle.arm();
    const edits = setup(5, true);
    edits.idle.arm();
    const offline = setup();
    offline.session.markDisconnected();
    offline.idle.arm();
    await elapse(60 * 60_000);
    expect(zero.disconnect).not.toHaveBeenCalled();
    expect(edits.disconnect).not.toHaveBeenCalled();
    expect(offline.disconnect).not.toHaveBeenCalled();
  });

  it("clear stops the countdown", async () => {
    const { disconnect, idle } = setup();
    idle.arm();
    idle.clear();
    await elapse(10 * 60_000);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("does nothing when the panel disconnected before the timeout", async () => {
    const { session, disconnect, idle } = setup();
    idle.arm();
    session.markDisconnected();
    await elapse(5 * 60_000);
    expect(disconnect).not.toHaveBeenCalled();
  });
});
