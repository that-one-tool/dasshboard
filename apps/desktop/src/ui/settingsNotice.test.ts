/** @vitest-environment happy-dom */

import { describe, it, expect, vi, afterEach } from "vitest";
import { setLocale } from "../i18n";
import { SettingsNotice } from "./settingsNotice";

describe("SettingsNotice", () => {
  afterEach(() => setLocale("en"));

  it("starts hidden", () => {
    const notice = new SettingsNotice(vi.fn());
    expect(notice.element.hidden).toBe(true);
    expect(notice.isShown()).toBe(false);
  });

  it("says the settings changed and offers Reconnect once shown", () => {
    const onReconnect = vi.fn();
    const notice = new SettingsNotice(onReconnect);
    notice.show("a");
    expect(notice.isShown()).toBe(true);
    expect(notice.element.textContent).toContain("Settings changed — reconnect to apply");
    notice.element.querySelector<HTMLButtonElement>("button")!.click();
    expect(onReconnect.mock.calls).toEqual([["a"]]);
  });

  it("offers no Reconnect once hidden", () => {
    const onReconnect = vi.fn();
    const notice = new SettingsNotice(onReconnect);
    notice.show("a");
    notice.hide();
    notice.element.querySelector<HTMLButtonElement>("button")!.click();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("hides again", () => {
    const notice = new SettingsNotice(vi.fn());
    notice.show("a");
    notice.hide();
    expect(notice.element.hidden).toBe(true);
  });

  it("keeps an edit made while connecting until the connection opens", () => {
    const notice = new SettingsNotice(vi.fn());
    notice.markPending("a");
    expect(notice.isShown()).toBe(false);
    notice.showPending();
    expect(notice.isShown()).toBe(true);
  });

  it("shows nothing on open without a pending edit", () => {
    const notice = new SettingsNotice(vi.fn());
    notice.showPending();
    expect(notice.isShown()).toBe(false);
  });

  it("forgets a pending edit once hidden", () => {
    const notice = new SettingsNotice(vi.fn());
    notice.markPending("a");
    notice.hide();
    notice.showPending();
    expect(notice.isShown()).toBe(false);
  });

  it("relabels in a new language", () => {
    const notice = new SettingsNotice(vi.fn());
    setLocale("fr");
    notice.retranslate();
    expect(notice.element.querySelector("button")!.textContent).toBe("Reconnecter");
  });
});
