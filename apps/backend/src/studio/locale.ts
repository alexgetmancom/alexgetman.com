/** Locale primitives shared by Studio services and every interface. */
export type StudioLocale = "en" | "ru";

export function localize(locale: StudioLocale, en: string, ru: string): string {
  return locale === "ru" ? ru : en;
}
