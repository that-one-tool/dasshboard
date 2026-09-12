/**
 * @vitest-environment happy-dom
 *
 * Tests for the i18n runtime: locale resolution (stored → OS → English),
 * interpolation, plural selection per locale, translation completeness of the
 * French table, DOM translation, and locale-change notifications.
 *
 * The suite restores English at the end of each test so the default-locale
 * assumption the rest of the app's tests rely on is never left perturbed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "./en";
import { fr } from "./fr";
import {
  SUPPORTED_LOCALES,
  applyDomTranslations,
  getLocale,
  isSupportedLocale,
  onLocaleChange,
  resolveLocale,
  setLocale,
  t,
  tp,
} from "./index";

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

describe("translation tables", () => {
  it("French defines every English key (no missing translations)", () => {
    const missing = Object.keys(en).filter((k) => !(k in fr));
    expect(missing).toEqual([]);
  });

  it("French adds no keys English lacks (no stale keys)", () => {
    const extra = Object.keys(fr).filter((k) => !(k in en));
    expect(extra).toEqual([]);
  });
});

describe("t", () => {
  it("returns the English string by default", () => {
    expect(t("common.close")).toBe("Close");
  });

  it("returns the active locale's string after setLocale", () => {
    setLocale("fr");
    expect(t("common.close")).toBe("Fermer");
  });

  it("interpolates named parameters", () => {
    expect(t("sftp.drawer.titleFor", { name: "web01" })).toBe("Files — web01");
  });

  it("leaves an unmatched placeholder in place", () => {
    // `error.prefix` expects {message}; passing none leaves the token.
    expect(t("error.prefix")).toBe("Error: {message}");
  });
});

describe("tp (plural)", () => {
  it("selects the English one/other forms by n === 1", () => {
    expect(tp("sftp.count", 1)).toBe("1 item");
    expect(tp("sftp.count", 3)).toBe("3 items");
    expect(tp("sftp.count", 0)).toBe("0 items");
  });

  it("treats 0 and 1 as singular in French", () => {
    setLocale("fr");
    expect(tp("sftp.count", 0)).toBe("1 élément"); // fr singular, count interpolated
    expect(tp("sftp.count", 1)).toBe("1 élément");
    expect(tp("sftp.count", 2)).toBe("2 éléments");
  });

  it("merges extra params alongside the count", () => {
    expect(tp("devices.importedSshSkipped", 2, { skipped: 3 })).toBe(
      "Imported 2 devices from SSH config (3 skipped)",
    );
  });
});

describe("resolveLocale", () => {
  it("prefers a stored supported locale", () => {
    expect(resolveLocale("fr", ["en-US"])).toBe("fr");
  });

  it("falls back to the OS primary subtag when no stored locale", () => {
    expect(resolveLocale(null, ["fr-CA", "en"])).toBe("fr");
  });

  it("falls back to English for an unsupported OS locale", () => {
    expect(resolveLocale(null, ["de-DE", "es"])).toBe("en");
  });

  it("ignores an unsupported stored value and uses the OS", () => {
    expect(resolveLocale("de", ["fr"])).toBe("fr");
  });

  it("returns English when nothing matches and no OS info", () => {
    expect(resolveLocale(undefined, [])).toBe("en");
  });
});

describe("isSupportedLocale", () => {
  it("accepts shipped locales and rejects others", () => {
    for (const loc of SUPPORTED_LOCALES) expect(isSupportedLocale(loc)).toBe(true);
    expect(isSupportedLocale("de")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
  });
});

describe("setLocale + onLocaleChange", () => {
  it("notifies subscribers on a real change, not a no-op", () => {
    const spy = vi.fn();
    const off = onLocaleChange(spy);
    setLocale("en"); // already English → no notification
    expect(spy).not.toHaveBeenCalled();
    setLocale("fr");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getLocale()).toBe("fr");
    off();
    setLocale("en");
    expect(spy).toHaveBeenCalledTimes(1); // unsubscribed
  });

  it("coerces an unsupported locale to English", () => {
    setLocale("de" as never);
    expect(getLocale()).toBe("en");
  });
});

describe("applyDomTranslations", () => {
  it("translates text, title, and aria-label attributes", () => {
    setLocale("fr");
    const root = document.createElement("div");
    root.innerHTML = `
      <span data-i18n="common.save"></span>
      <button data-i18n-title="devices.add.title" data-i18n-aria="devices.add.title"></button>
      <span data-i18n="not.a.real.key">keep</span>
    `;
    applyDomTranslations(root);
    expect(root.querySelector("span")?.textContent).toBe("Enregistrer");
    const btn = root.querySelector("button");
    expect(btn?.getAttribute("title")).toBe("Ajouter un appareil");
    expect(btn?.getAttribute("aria-label")).toBe("Ajouter un appareil");
    // An unknown key is left untouched (non-fatal).
    expect(root.querySelectorAll("span")[1]?.textContent).toBe("keep");
  });
});
