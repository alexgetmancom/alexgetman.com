import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { formatZonedDateTime } from "../../foundation/time.js";

/** Telegram presentation of a neutral scheduled timestamp. Reads the configured
 * zone through `formatZonedDateTime` like every other Studio surface: this used to
 * hardcode a deployment zone, so changing `timezone` in studio.yaml moved post times and
 * silently left video times behind. */
export function formatVideoTime(
  value: string | null,
  locale: StudioLocale,
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
): string {
  return value
    ? formatZonedDateTime(value, config.TIMEZONE, config.TIMEZONE_LABEL)
    : locale === "ru"
      ? "время не задано"
      : "time is not set";
}
