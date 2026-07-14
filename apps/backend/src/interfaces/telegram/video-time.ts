import type { BotLocale } from "../../bot/i18n.js";

/** Telegram presentation of a neutral scheduled timestamp. */
export function formatVideoTime(value: string | null, locale: BotLocale = "ru"): string {
  return value
    ? new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Europe/Moscow",
      }).format(new Date(value))
    : locale === "ru"
      ? "время не задано"
      : "time is not set";
}
