/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import { t } from "../../i18n";
import { bookmarkLabel, renderBookmarks, renderBookmarkToggle } from "./bookmarksBar";

describe("bookmarkLabel", () => {
  it("is the path's last segment, or / for the root", () => {
    expect(bookmarkLabel("/var/log")).toBe("log");
    expect(bookmarkLabel("/var/log/")).toBe("log");
    expect(bookmarkLabel("/")).toBe("/");
    expect(bookmarkLabel("")).toBe("/");
    expect(bookmarkLabel("relative")).toBe("relative");
  });
});

describe("renderBookmarks", () => {
  it("hides the bar when there are no bookmarks", () => {
    const el = document.createElement("div");
    renderBookmarks(el, [], "/");
    expect(el.hidden).toBe(true);
  });

  it("renders a chip per path, marking the current directory", () => {
    const el = document.createElement("div");
    renderBookmarks(el, ["/etc", "/var/<log>"], "/etc");
    const chips = el.querySelectorAll<HTMLElement>(".sftp-bookmark");
    expect(el.hidden).toBe(false);
    expect(chips.length).toBe(2);
    expect(chips[0]?.classList.contains("is-current")).toBe(true);
    const go = chips[1]?.querySelector<HTMLElement>('[data-action="bookmark-go"]');
    expect(go?.textContent).toBe("<log>");
    expect(go?.dataset.path).toBe("/var/<log>");
    const del = chips[1]?.querySelector<HTMLElement>('[data-action="bookmark-del"]');
    expect(del?.getAttribute("aria-label")).toBe(t("sftp.bookmark.remove"));
  });
});

describe("renderBookmarkToggle", () => {
  it("offers to add, or to remove once marked", () => {
    const btn = document.createElement("button");
    renderBookmarkToggle(btn, false);
    expect(btn.title).toBe(t("sftp.bookmark.add"));
    expect(btn.classList.contains("is-marked")).toBe(false);
    renderBookmarkToggle(btn, true);
    expect(btn.getAttribute("aria-label")).toBe(t("sftp.bookmark.remove"));
    expect(btn.classList.contains("is-marked")).toBe(true);
  });
});
