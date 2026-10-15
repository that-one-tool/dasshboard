/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import { t } from "../../i18n";
import { sftpPanelMarkup } from "./panelTemplate";

function mounted(): HTMLElement {
  const panel = document.createElement("aside");
  panel.innerHTML = sftpPanelMarkup();
  return panel;
}

describe("sftpPanelMarkup", () => {
  it("has a control for every panel action", () => {
    const actions = [...mounted().querySelectorAll<HTMLElement>("[data-action]")].map((el) => el.dataset.action);
    expect(new Set(actions)).toEqual(
      new Set([
        "expand",
        "conn-toggle",
        "collapse",
        "hide",
        "copy-path",
        "back",
        "forward",
        "up",
        "refresh",
        "upload",
        "upload-dir",
        "mkdir",
        "bookmark-toggle",
        "sort",
        "select-all",
        "bulk-download",
        "bulk-cut",
        "bulk-paste",
        "bulk-delete",
        "bulk-clear",
      ]),
    );
  });

  it("has the regions the panel renders into", () => {
    const panel = mounted();
    for (const selector of [
      ".sftp-device-select",
      ".sftp-path",
      ".sftp-filter",
      ".sftp-bookmarks",
      ".sftp-bulkbar",
      ".sftp-entries",
      ".sftp-edits",
      ".sftp-queue",
      ".sftp-status",
    ]) {
      expect(panel.querySelector(selector), selector).not.toBeNull();
    }
  });

  it("labels its controls in the current locale", () => {
    const panel = mounted();
    expect(panel.querySelector(".sftp-device-select")?.getAttribute("aria-label")).toBe(t("sftp.selectDevice"));
    expect(panel.querySelector('[data-action="up"]')?.getAttribute("title")).toBe(t("sftp.nav.up"));
  });
});
