import { StudioError } from "../errors.js";
import { STUDIO_LOCALE_TAGS, type StudioLocale } from "../locale.js";
import { catalog, type MessageKey } from "./catalog.js";

export type { MessageKey };
export { catalog };

/** Render an error for the owner. A StudioError carries a catalog code, so it is
 * translated; anything else keeps its raw message for admin debugging. */
export function describeError(locale: StudioLocale, error: unknown): string {
  if (error instanceof StudioError && error.code in catalog.en) return t(locale, error.code as MessageKey, error.params);
  return error instanceof Error ? error.message : String(error);
}

/** Translate one interface key, interpolating `{name}` placeholders from params.
 * Domain and MCP never call this: they return codes, the renderer translates.
 * The renderer may be a Telegram screen or an analytics report — this function
 * knows about neither. */
export function t(locale: StudioLocale, key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalog[locale]?.[key] ?? catalog.en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

/** CLDR plural selection for the ~handful of counted strings. Each form carries
 * its own `{n}` placeholder, e.g. plural("ru", 3, { one: "{n} день", few: "{n} дня", many: "{n} дней" }).
 *
 * Selection is Intl's, not ours: a hand-written `if (locale === "ru")` would
 * have to grow a branch for every language added, and CLDR already knows the
 * rules for all of them. A locale that needs a form the caller did not supply
 * falls back down the chain rather than rendering nothing. */
type PluralForms = { one: string; few?: string; many: string; other?: string };
export function plural(locale: StudioLocale, n: number, forms: PluralForms): string {
  const category = new Intl.PluralRules(STUDIO_LOCALE_TAGS[locale]).select(n);
  const form = forms[category as keyof PluralForms] ?? forms.other ?? forms.many;
  return form.replace(/\{n\}/g, String(n));
}
