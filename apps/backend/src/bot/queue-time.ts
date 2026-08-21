import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { formatZonedClock, formatZonedDayMonth, zonedDayDistance } from "../foundation/time.js";

/** How the bot writes the time of one queued or published item.
 *
 * The queue list and the menu headline say the same thing about the same
 * publication, so they say it with the same function: as two copies they
 * disagreed about which days get a name — one knew "tomorrow", the other
 * "yesterday" — and each carried its own formatter cache. */
export function formatQueueTime(date: Date, now: Date, locale: StudioLocale, timeZone: string): string {
  const clock = formatZonedClock(date, locale, timeZone);
  const distance = zonedDayDistance(date, now, timeZone);
  if (distance === 0) return `${t(locale, "common.today")}, ${clock}`;
  if (distance === -1) return `${t(locale, "common.yesterday")}, ${clock}`;
  if (distance === 1) return `${t(locale, "common.tomorrow")}, ${clock}`;
  return `${formatZonedDayMonth(date, locale, timeZone)}, ${clock}`;
}
