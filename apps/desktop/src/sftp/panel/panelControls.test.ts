/** @vitest-environment happy-dom */
import { describe, it, expect } from "vitest";
import { PanelControls } from "./panelControls";
import { buildPanelElements } from "./panelElements";
import { PanelSession } from "./panelSession";
import { DirHistory } from "./dirHistory";
import { t } from "../../i18n";

function setup() {
  const els = buildPanelElements(document.createElement("aside"));
  const session = new PanelSession();
  const history = new DirHistory();
  return { els, session, history, controls: new PanelControls(() => els, session, history) };
}

describe("PanelControls", () => {
  it("shows a status text", () => {
    const { els, controls } = setup();
    controls.setStatus("hello");
    expect(els.status.textContent).toBe("hello");
  });

  it("disables browsing while disconnected, but not the picker", () => {
    const { els, controls } = setup();
    controls.syncControls();
    expect(els.path.readOnly).toBe(true);
    expect(els.filter.disabled).toBe(true);
    expect(els.root.querySelector<HTMLButtonElement>('[data-action="sort"]')?.disabled).toBe(true);
    expect(els.deviceSelect.disabled).toBe(false);
  });

  it("disables everything while busy, and re-enables once idle", () => {
    const { els, session, controls } = setup();
    session.markConnected("a");
    controls.setBusy(true);
    expect(controls.isBusy()).toBe(true);
    expect(els.deviceSelect.disabled).toBe(true);
    expect(els.path.readOnly).toBe(true);

    controls.setBusy(false);
    expect(els.deviceSelect.disabled).toBe(false);
    expect(els.path.readOnly).toBe(false);
    expect(els.root.querySelector<HTMLButtonElement>('[data-action="upload"]')?.disabled).toBe(false);
  });

  it("enables Back and Forward per the history once idle and connected", () => {
    const { els, session, history, controls } = setup();
    session.markConnected("a");
    history.record("/a");
    history.record("/b");
    controls.syncControls();
    expect(els.back.disabled).toBe(false);
    expect(els.forward.disabled).toBe(true);
  });

  it("shows a disconnect toggle and a lit dot when connected", () => {
    const { els, session, controls } = setup();
    session.markConnected("a");
    controls.updateConnToggle();
    expect(els.connDot.classList.contains("connected")).toBe(true);
    expect(els.connToggle.classList.contains("is-connected")).toBe(true);
    expect(els.connToggle.getAttribute("aria-label")).toBe(t("sftp.disconnect"));
    expect(els.connToggle.disabled).toBe(false);
  });

  it("makes the connect toggle inert with no device picked, or mid-connect", () => {
    const { els, session, controls } = setup();
    controls.updateConnToggle();
    expect(els.connToggle.classList.contains("is-disconnected")).toBe(true);
    expect(els.connToggle.title).toBe(t("sftp.connect"));
    expect(els.connToggle.disabled).toBe(true);

    session.pickDevice("a");
    controls.updateConnToggle();
    expect(els.connToggle.disabled).toBe(false);

    session.startConnecting();
    controls.updateConnToggle();
    expect(els.connToggle.disabled).toBe(true);
  });
});
