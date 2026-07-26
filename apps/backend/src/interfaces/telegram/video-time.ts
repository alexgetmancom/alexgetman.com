import type { BotLocale } from "../../bot/i18n.js";
import type { BackendConfig } from "../../foundation/config.js";
import { formatMsk } from "./time.js";

/** Telegram presentation of a neutral scheduled timestamp. Reads the configured
 * zone through `formatMsk` like every other Studio surface: this used to hardcode
 * Europe/Moscow, so changing `timezone` in studio.yaml moved post times and
 * silently left video times behind. */
export function formatVideoTime(
  value: string | null,
  locale: BotLocale,
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
): string {
  return value ? formatMsk(value, config) : locale === "ru" ? "время не задано" : "time is not set";
}
