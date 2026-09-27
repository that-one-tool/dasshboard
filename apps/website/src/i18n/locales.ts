// Mirrors the desktop app's SUPPORTED_LOCALES (apps/desktop/src/i18n/index.ts).
// English lives at the site root; every other locale under /<locale>/.
export const SUPPORTED_LOCALES = ["en", "fr", "es", "de", "pt", "zh", "ja"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const TRANSLATED_LOCALES = SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

export const LOCALE_NAMES: Record<Locale, string> = {
	en: "English",
	fr: "Français",
	es: "Español",
	de: "Deutsch",
	pt: "Português",
	zh: "简体中文",
	ja: "日本語",
};

export const HTML_LANG: Record<Locale, string> = {
	en: "en",
	fr: "fr",
	es: "es",
	de: "de",
	pt: "pt",
	zh: "zh-Hans",
	ja: "ja",
};

export function isSupportedLocale(value: string | undefined): value is Locale {
	return (SUPPORTED_LOCALES as readonly (string | undefined)[]).includes(value);
}

export function localePath(locale: Locale, base: string): string {
	const root = base.replace(/\/$/, "");
	return locale === DEFAULT_LOCALE ? `${root}/` : `${root}/${locale}/`;
}

export function format(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => vars[name] ?? placeholder);
}
