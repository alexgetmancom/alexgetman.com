import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import type { StudioQueueItem, StudioQueueSnapshot } from "../studio/services/queue.js";
import { type BotLocale, botLocale } from "./i18n.js";

const UPCOMING_PAGE_SIZE = 5;
const ATTENTION_PAGE_SIZE = 5;
const DRAFT_PAGE_SIZE = 10;

export async function showQueue(ctx: Context, backendDb: BackendDb, config: BackendConfig, page = 0): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const snapshot = createStudioServices(backendDb, config).queue.snapshot(Number(ctx.from?.id));
  const keyboard = new InlineKeyboard();
  const currentPage = Math.max(0, Math.min(Math.trunc(page), queuePageCount(snapshot) - 1));
  const text = queueText(snapshot, locale, config.TIMEZONE, currentPage);

  for (const item of pageSlice(snapshot.upcoming, currentPage, UPCOMING_PAGE_SIZE))
    keyboard.text(itemButton(item, locale, config.TIMEZONE), itemCallback(item)).row();
  for (const item of pageSlice(snapshot.attention, currentPage, ATTENTION_PAGE_SIZE))
    keyboard.text(`⚠️ ${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  for (const item of pageSlice(snapshot.drafts, currentPage, DRAFT_PAGE_SIZE))
    keyboard.text(`${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  const pages = queuePageCount(snapshot);
  if (pages > 1) {
    keyboard.row();
    if (currentPage > 0) keyboard.text("←", `queue_page:${currentPage - 1}`);
    keyboard.text(`${currentPage + 1}/${pages}`, "queue_page:noop");
    if (currentPage < pages - 1) keyboard.text("→", `queue_page:${currentPage + 1}`);
  }
  keyboard.row().text(t(locale, "common.menu"), "menu_home");
  await replaceQueueMessage(ctx, text, keyboard);
}

export function queueText(snapshot: StudioQueueSnapshot, locale: BotLocale, timeZone: string, page = 0): string {
  const currentPage = Math.max(0, Math.min(Math.trunc(page), queuePageCount(snapshot) - 1));
  const lines = [`📋 *${t(locale, "queue.title")}*`, "", `*${t(locale, "queue.upcoming-heading")}*`];
  const upcoming = pageSlice(snapshot.upcoming, currentPage, UPCOMING_PAGE_SIZE);
  if (!upcoming.length) lines.push(t(locale, "queue.nothing-scheduled"));
  else for (const item of upcoming) lines.push(`• ${formatQueueTime(item.time, locale, timeZone)} — ${kindIcon(item.kind)} ${item.label}`);
  if (snapshot.attention.length) {
    lines.push("", `*${t(locale, "queue.attention-heading", { count: snapshot.attention.length })}*`);
    for (const item of pageSlice(snapshot.attention, currentPage, ATTENTION_PAGE_SIZE))
      lines.push(`• ⚠️ ${kindIcon(item.kind)} ${item.label}`);
  }
  lines.push("", `*${t(locale, "queue.drafts-btn", { count: snapshot.drafts.length })}*`);
  const drafts = pageSlice(snapshot.drafts, currentPage, DRAFT_PAGE_SIZE);
  lines.push(drafts.length ? t(locale, "queue.choose-draft") : t(locale, "queue.no-drafts"));
  if (queuePageCount(snapshot) > 1) lines.push("", t(locale, "queue.page", { page: currentPage + 1, pages: queuePageCount(snapshot) }));
  return lines.join("\n");
}

export function queuePageCount(snapshot: StudioQueueSnapshot): number {
  return Math.max(
    1,
    Math.ceil(snapshot.upcoming.length / UPCOMING_PAGE_SIZE),
    Math.ceil(snapshot.attention.length / ATTENTION_PAGE_SIZE),
    Math.ceil(snapshot.drafts.length / DRAFT_PAGE_SIZE),
  );
}

function pageSlice<T>(items: T[], page: number, size: number): T[] {
  return items.slice(page * size, (page + 1) * size);
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
