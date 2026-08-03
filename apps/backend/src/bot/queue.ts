import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import type { StudioQueueItem, StudioQueueSnapshot } from "../studio/services/queue.js";
import { type BotLocale, botLocale } from "./i18n.js";

export async function showQueue(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const snapshot = createStudioServices(backendDb, config).queue.snapshot(Number(ctx.from?.id));
  const keyboard = new InlineKeyboard();
  const text = queueText(snapshot, locale, config.TIMEZONE);

  for (const item of snapshot.upcoming.slice(0, 5)) keyboard.text(itemButton(item, locale, config.TIMEZONE), itemCallback(item)).row();
  for (const item of snapshot.attention.slice(0, 5)) keyboard.text(`⚠️ ${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  for (const item of snapshot.drafts.slice(0, 10)) keyboard.text(`${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  keyboard.row().text(t(locale, "common.menu"), "menu_home");
  await replaceQueueMessage(ctx, text, keyboard);
}

export function queueText(snapshot: StudioQueueSnapshot, locale: BotLocale, timeZone: string): string {
  const lines = [`📋 *${t(locale, "queue.title")}*`, "", `*${t(locale, "queue.upcoming-heading")}*`];
  if (!snapshot.upcoming.length) lines.push(t(locale, "queue.nothing-scheduled"));
  else
    for (const item of snapshot.upcoming.slice(0, 5))
      lines.push(`• ${formatQueueTime(item.time, locale, timeZone)} — ${kindIcon(item.kind)} ${item.label}`);
  if (snapshot.attention.length) {
    lines.push("", `*${t(locale, "queue.attention-heading", { count: snapshot.attention.length })}*`);
    for (const item of snapshot.attention.slice(0, 5)) lines.push(`• ⚠️ ${kindIcon(item.kind)} ${item.label}`);
  }
  lines.push("", `*${t(locale, "queue.drafts-btn", { count: snapshot.drafts.length })}*`);
  lines.push(snapshot.drafts.length ? t(locale, "queue.choose-draft") : t(locale, "queue.no-drafts"));
  return lines.join("\n");
}

function itemButton(item: StudioQueueItem, locale: BotLocale, timeZone: string): string {
  const targets = item.targets ? ` · ${item.targets} ${t(locale, "queue.platforms-suffix")}` : "";
  return `${formatQueueTime(item.time, locale, timeZone)} · ${kindIcon(item.kind)} ${item.label}${targets}`.slice(0, 60);
}

function kindIcon(kind: StudioQueueItem["kind"]): string {
  return kind === "post" ? "📝" : "🎬";
}

function itemCallback(item: Pick<StudioQueueItem, "id" | "kind">): string {
  return item.kind === "post" ? `preview:${item.id}` : `video_open:${item.id}`;
}

async function replaceQueueMessage(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId && ctx.chat?.id)
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

/** Intl.DateTimeFormat construction is expensive and this runs per queue row,
 * so formatters are built once per (kind, locale, zone) and reused. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: "day-key" | "clock" | "day", locale: BotLocale, timeZone: string): Intl.DateTimeFormat {
  const cacheKey = `${kind}:${locale}:${timeZone}`;
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;
  const intlLocale = locale === "ru" ? "ru-RU" : "en-GB";
  const created =
    kind === "day-key"
      ? new Intl.DateTimeFormat("en-CA", { timeZone })
      : kind === "clock"
        ? new Intl.DateTimeFormat(intlLocale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone })
        : new Intl.DateTimeFormat(intlLocale, { day: "numeric", month: "short", timeZone });
  formatterCache.set(cacheKey, created);
  return created;
}

/** `timeZone` comes from studio.yaml via config, not a constant: the Studio runs
 * for more than one account and every other schedule surface already reads it
 * from there (see foundation/time.ts). */
function formatQueueTime(date: Date, locale: BotLocale, timeZone: string): string {
  const now = new Date();
  const dayKey = formatter("day-key", locale, timeZone);
  const time = formatter("clock", locale, timeZone).format(date);
  if (dayKey.format(date) === dayKey.format(now)) return `${t(locale, "common.today")}, ${time}`;
  if (dayKey.format(date) === dayKey.format(new Date(now.getTime() + 24 * 60 * 60_000))) return `${t(locale, "common.tomorrow")}, ${time}`;
  return `${formatter("day", locale, timeZone).format(date)}, ${time}`;
}
