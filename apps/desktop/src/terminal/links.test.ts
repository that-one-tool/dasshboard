/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from "vitest";
import { isWebUrl, linkActivator, linkHandlers, linkHintKey, wantsLinkOpen } from "./links";
import { setLocale } from "../i18n";

const click = (mods: { ctrlKey?: boolean; metaKey?: boolean }) =>
  ({ ctrlKey: false, metaKey: false, ...mods }) as MouseEvent;

describe("isWebUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isWebUrl("https://example.com/a?b=1")).toBe(true);
    expect(isWebUrl("http://10.0.0.1:8080")).toBe(true);
  });

  it("rejects any other scheme and junk", () => {
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
  });
});

describe("wantsLinkOpen", () => {
  it("is Ctrl+click elsewhere, Cmd+click on macOS", () => {
    expect(wantsLinkOpen(click({ ctrlKey: true }), false)).toBe(true);
    expect(wantsLinkOpen(click({ metaKey: true }), true)).toBe(true);
  });

  it("ignores a plain click (it selects text) and the other platform's key", () => {
    expect(wantsLinkOpen(click({}), false)).toBe(false);
    expect(wantsLinkOpen(click({ metaKey: true }), false)).toBe(false);
    expect(wantsLinkOpen(click({ ctrlKey: true }), true)).toBe(false);
  });
});

describe("linkActivator", () => {
  it("opens a web URL on a modified click", () => {
    const open = vi.fn(async () => {});
    linkActivator(open, () => {}, false)(click({ ctrlKey: true }), "https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com");
  });

  it("does nothing on a plain click or for a non-web URL", () => {
    const open = vi.fn(async () => {});
    const activate = linkActivator(open, () => {}, false);
    activate(click({}), "https://example.com");
    activate(click({ ctrlKey: true }), "file:///etc/passwd");
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a failure to open", async () => {
    const onError = vi.fn();
    const open = vi.fn(async () => {
      throw new Error("no browser");
    });
    linkActivator(open, onError, false)(click({ ctrlKey: true }), "https://example.com");
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith("no browser");
  });
});

describe("linkHintKey", () => {
  it("names the platform's modifier", () => {
    expect(linkHintKey(false)).toBe("pane.link.hint");
    expect(linkHintKey(true)).toBe("pane.link.hintMac");
  });
});

describe("linkHandlers", () => {
  it("shows the hint while hovering a link and removes it after", () => {
    setLocale("en");
    const el = document.createElement("div");
    const handlers = linkHandlers(el, async () => {}, () => {}, false);
    handlers.hover(new MouseEvent("mousemove"), "https://evil.example/login");
    // The real target, since an OSC 8 link's visible text can claim any address.
    expect(el.title).toBe("https://evil.example/login\nCtrl+click to open the link");
    handlers.leave();
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("activates through the same modifier rule", () => {
    const open = vi.fn(async () => {});
    const handlers = linkHandlers(document.createElement("div"), open, () => {}, false);
    handlers.activate(click({}), "https://example.com");
    handlers.activate(click({ ctrlKey: true }), "https://example.com");
    expect(open).toHaveBeenCalledOnce();
  });
});
