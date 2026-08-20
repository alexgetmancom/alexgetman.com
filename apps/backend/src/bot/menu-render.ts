import type { Menu } from "@grammyjs/menu";
import { type Context, Keyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { truncateUnicode } from "../foundation/text.js";
import { queueService, type StudioQueueActivity } from "../studio/services/queue.js";
import { settingsService } from "../studio/services/settings.js";

/** Rendering the main menu, separated from building it.
 *
 * These two helpers used to live in navigation.ts next to `buildMainMenu`, which
 * put them behind that module's imports of every screen it can open — so a
 * screen needing nothing but the persistent keyboard had to import back into
 * navigation, and post-screen and settings each closed an import cycle.
 * Neither helper knows how the menu is assembled: `showMainMenu` takes the built
 * menu as an argument. */

export function persistentKeyboard(locale: StudioLocale = "en"): Keyboard {
  return new Keyboard().text(t(locale, "menu.button")).resized().persistent();
}

export async function showMainMenu(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mainMenu: Menu<Context>,
  edit = false,
): Promise<void> {
  const options = { reply_markup: mainMenu };
  const text = mainMenuText(backendDb, config, Number(ctx.from?.id));
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

export function mainMenuText(backendDb: BackendDb, config: BackendConfig, actorId: number): string {
  const locale = settingsService(backendDb).locale(actorId);
  const timeZone = settingsService(backendDb).timeConfig(actorId, config).TIMEZONE;
  return renderMainMenuHeadline(queueService(backendDb, config).headline(actorId), locale, timeZone, backendDb.clock.now());
}

export function renderMainMenuHeadline(
  activity: { upcoming: StudioQueueActivity | null; published: StudioQueueActivity | null },
  locale: StudioLocale,
  timeZone: string,
  now: Date,
): string {
  const item = activity.upcoming ?? activity.published;
  if (!item) return t(locale, "menu.queue-empty");
  const prefix = activity.upcoming ? "⏭" : "✅";
  const kind = item.kind === "post" ? "📝" : "🎬";
  return `${prefix} ${formatActivityTime(item.time, now, locale, timeZone)} · ${kind} ${headlineLabel(item.label)}`;
}

function headlineLabel(value: string): string {
  const limit = 20;
  return Array.from(value).length > limit ? `${truncateUnicode(value, limit)}...` : value;
}

const menuFormatterCache = new Map<string, Intl.DateTimeFormat>();

function menuFormatter(kind: "clock" | "date" | "parts", locale: StudioLocale, timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}:${locale}:${timeZone}`;
  const cached = menuFormatterCache.get(key);
  if (cached) return cached;
  const intlLocale = locale === "ru" ? "ru-RU" : "en-GB";
  const formatter = new Intl.DateTimeFormat(
    kind === "parts" ? "en-CA" : intlLocale,
    kind === "clock"
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }
      : kind === "date"
        ? { day: "numeric", month: "short", timeZone }
        : { year: "numeric", month: "2-digit", day: "2-digit", timeZone },
  );
  menuFormatterCache.set(key, formatter);
  return formatter;
}

function formatActivityTime(date: Date, now: Date, locale: StudioLocale, timeZone: string): string {
  const clock = menuFormatter("clock", locale, timeZone).format(date);
  const dayDistance = zonedDayNumber(date, timeZone) - zonedDayNumber(now, timeZone);
  if (dayDistance === 0) return `${t(locale, "common.today")}, ${clock}`;
  if (dayDistance === -1) return `${t(locale, "common.yesterday")}, ${clock}`;
  if (dayDistance === 1) return `${t(locale, "common.tomorrow")}, ${clock}`;
  return `${menuFormatter("date", locale, timeZone).format(date)}, ${clock}`;
}

function zonedDayNumber(date: Date, timeZone: string): number {
  const values = Object.fromEntries(
    menuFormatter("parts", "en", timeZone)
      .formatToParts(date)
      .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
      .map((part) => [part.type, Number(part.value)]),
  );
  return Math.floor(Date.UTC(values.year ?? 0, (values.month ?? 1) - 1, values.day ?? 1) / 86_400_000);
}
