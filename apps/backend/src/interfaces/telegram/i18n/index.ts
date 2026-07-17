import { StudioError } from "../../../foundation/errors.js";
import { catalog, type MessageKey, type UiLocale } from "./catalog.js";

export type { MessageKey, UiLocale };
export { catalog };

/** Render an error for a Telegram user. A StudioError carries a catalog code,
 * so it is translated; anything else keeps its raw message for admin debugging. */
export function describeError(locale: UiLocale, error: unknown): string {
  if (error instanceof StudioError && error.code in catalog.en) return t(locale, error.code as MessageKey, error.params);
  return error instanceof Error ? error.message : String(error);
}

/** Translate one interface key, interpolating `{name}` placeholders from params.
 * Domain and MCP never call this: they return codes, the renderer translates. */
export function t(locale: UiLocale, key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalog[locale]?.[key] ?? catalog.en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

/** CLDR plural selection for the ~handful of counted strings. Each form carries
 * its own `{n}` placeholder, e.g. plural("ru", 3, { one: "{n} день", few: "{n} дня", many: "{n} дней" }). */
type PluralForms = { one: string; few?: string; many: string };
export function plural(locale: UiLocale, n: number, forms: PluralForms): string {
  return selectPluralForm(locale, n, forms).replace(/\{n\}/g, String(n));
}

function selectPluralForm(locale: UiLocale, n: number, forms: PluralForms): string {
  if (locale === "ru") {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return forms.one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms.few ?? forms.many;
    return forms.many;
  }
  return n === 1 ? forms.one : forms.many;
}

/** Resolve the UI locale: a durable owner choice wins, else the Telegram client
 * language, else English. Only the first step is authoritative once persisted. */
export function resolveUiLocale(stored: string | null | undefined, telegramLang?: string | null): UiLocale {
  if (stored === "ru" || stored === "en") return stored;
  if (telegramLang?.toLowerCase().startsWith("ru")) return "ru";
  return "en";
}
