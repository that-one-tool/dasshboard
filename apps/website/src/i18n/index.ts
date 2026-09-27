import { en, type SiteMessages } from "./en";
import { fr } from "./fr";
import { es } from "./es";
import { de } from "./de";
import { pt } from "./pt";
import { zh } from "./zh";
import { ja } from "./ja";
import type { Locale } from "./locales";

const TABLES: Record<Locale, SiteMessages> = { en, fr, es, de, pt, zh, ja };

export function messagesFor(locale: Locale): SiteMessages {
	return TABLES[locale];
}
