/**
 * Frontend localization (i18n) runtime.
 *
 * A tiny, dependency-free layer over the per-locale message tables in `en.ts` /
 * `fr.ts`. It owns the current locale (module-level, since there is one UI),
 * looks up + interpolates messages via {@link t}, selects plural forms via
 * {@link tp}, and lets long-lived views re-render on a language change via
 * {@link onLocaleChange}.
 *
 * Design notes:
 * - English is the default until {@link setLocale} runs, so unit tests (which
 *   never switch locale) assert against the English source in `en.ts`.
 * - A missing/unknown key returns the key itself (visible but non-fatal); this
 *   can only happen for a bad dynamic key since `t`'s parameter is typed.
 * - The OS default is read from `navigator.language` — in the Tauri webview this
 *   reflects the operating system's UI locale on all platforms — falling back to
 *   English for any unsupported language.
 */

import { en, type MessageKey, type Messages } from "./en";
import { fr } from "./fr";
import { es } from "./es";
import { de } from "./de";
import { pt } from "./pt";
import { zh } from "./zh";
import { ja } from "./ja";

/** The locales the app ships translations for. English is the guaranteed fallback. */
export const SUPPORTED_LOCALES = ["en", "fr", "es", "de", "pt", "zh", "ja"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Human-readable, endonym language names for the settings picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
  pt: "Português",
  zh: "简体中文",
  ja: "日本語",
};

const TABLES: Record<Locale, Messages> = { en, fr, es, de, pt, zh, ja };

/** English is the default so an un-configured app (and every test) reads `en`. */
let currentLocale: Locale = "en";

/** Subscribers re-rendered on a language change (long-lived views). */
const listeners = new Set<() => void>();

/** Whether `value` is one of the shipped locales. */
export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** The locale currently in effect. */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Resolve the locale to use from the persisted setting and the OS. A stored,
 * supported locale wins; otherwise the OS UI language (its primary subtag, e.g.
 * `fr` from `fr-CA`) is used when supported; otherwise English. `stored` is the
 * value from `settings.language` — `null`/`undefined` means "follow the OS".
 */
export function resolveLocale(
  stored: string | null | undefined,
  navigatorLanguages: readonly string[] = navigatorLocales(),
): Locale {
  if (isSupportedLocale(stored)) return stored;
  for (const lang of navigatorLanguages) {
    const primary = lang.toLowerCase().split("-")[0];
    if (isSupportedLocale(primary)) return primary;
  }
  return "en";
}

/** The browser/OS preferred languages, most-preferred first (empty when absent). */
function navigatorLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : [];
}

/**
 * Switch the active locale and notify subscribers so open views re-render. A
 * no-op (no notification) when the locale is unchanged. An unsupported value is
 * coerced to English rather than left dangling.
 */
export function setLocale(locale: Locale): void {
  const next = isSupportedLocale(locale) ? locale : "en";
  if (next === currentLocale) return;
  currentLocale = next;
  for (const listener of [...listeners]) listener();
}

/** Subscribe to locale changes; returns an unsubscribe function. */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Translate `key` in the current locale, interpolating `{name}` tokens from
 * `params`. Falls back to the English string for a key missing in the active
 * locale, then to the key itself.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const table = TABLES[currentLocale];
  const raw = table[key] ?? en[key] ?? key;
  return interpolate(raw, params);
}

/**
 * Translate a countable message: looks up `${base}.one` or `${base}.other`
 * per the active locale's plural rule and interpolates, exposing the count as
 * `{count}`. Extra `params` (e.g. `{skipped}`) are merged in.
 */
export function tp(
  base: string,
  count: number,
  params?: Record<string, string | number>,
): string {
  const form = pluralCategory(currentLocale, count);
  const key = `${base}.${form}` as MessageKey;
  return t(key, { count, ...params });
}

/** Endonym name for a locale, for the settings picker. */
export function localeName(locale: Locale): string {
  return LOCALE_NAMES[locale];
}

/**
 * Replace `{token}` occurrences with `params` values. Unmatched tokens are left
 * in place (surfaces a missing param without throwing).
 */
function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/**
 * Plural category for a count. French: `one` for 0 and 1 (French treats 0 as
 * singular), `other` otherwise. Chinese and Japanese have no plural distinction,
 * so everything is `other`. English, Spanish, German and Portuguese: `one` iff
 * n === 1. Covers the small, countable set of messages the app uses (items,
 * devices, profiles, lines…).
 */
function pluralCategory(locale: Locale, count: number): "one" | "other" {
  const n = Math.abs(count);
  if (locale === "fr") return n < 2 ? "one" : "other";
  if (locale === "zh" || locale === "ja") return "other";
  return n === 1 ? "one" : "other";
}

/* -------------------------------------------------------------------------- */
/* Static DOM translation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Translate the static markup in `index.html` (and any re-scanned root). An
 * element opts in with one or more attributes:
 * - `data-i18n="key"`         → sets `textContent`
 * - `data-i18n-title="key"`   → sets the `title` attribute
 * - `data-i18n-aria="key"`    → sets the `aria-label` attribute
 *
 * Idempotent, so it can run again after a locale change to re-translate in place.
 */
export function applyDomTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (isKey(key)) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (isKey(key)) el.setAttribute("title", t(key));
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
    const key = el.dataset.i18nAria;
    if (isKey(key)) el.setAttribute("aria-label", t(key));
  });
}

/** Narrow a raw `data-*` value to a known message key (unknown ⇒ skip). */
function isKey(value: string | undefined): value is MessageKey {
  return value !== undefined && value in en;
}
