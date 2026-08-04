import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { createStudioServices } from "../studio/services/index.js";
import type { StudioQueueAttentionItem, StudioQueueItem, StudioQueueSnapshot } from "../studio/services/queue.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { publicationCallback } from "./session-fsm.js";
import { isUnchangedMessageEdit } from "./telegram-errors.js";

const QUEUE_PAGE_SIZE = 10;
const ATTENTION_PAGE_SIZE = 10;

type QueuePage = { upcoming: StudioQueueItem[]; drafts: StudioQueueItem[] };

export async function showQueue(ctx: Context, backendDb: BackendDb, config: BackendConfig, page = 0): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const snapshot = createStudioServices(backendDb, config).queue.snapshot(Number(ctx.from?.id));
  const keyboard = new InlineKeyboard();
  const pages = queuePageCount(snapshot, config.TIMEZONE);
  const currentPage = Math.max(0, Math.min(Math.trunc(page), pages - 1));
  const pageItems = queuePage(snapshot, config.TIMEZONE, currentPage);
  const text = queueText(snapshot, locale, config.TIMEZONE, currentPage);

  for (const item of pageItems.upcoming) keyboard.text(itemButton(item, locale, config.TIMEZONE), itemCallback(item)).row();
  for (const item of pageItems.drafts) keyboard.text(`${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  if (snapshot.attention.length)
    keyboard.text(t(locale, "queue.attention-btn", { count: snapshot.attention.length }), "queue_attention").row();
  if (pages > 1) {
    keyboard.row();
    if (currentPage > 0) keyboard.text("←", `queue_page:${currentPage - 1}`);
    keyboard.text(`${currentPage + 1}/${pages}`, "queue_page:noop");
    if (currentPage < pages - 1) keyboard.text("→", `queue_page:${currentPage + 1}`);
  }
  keyboard.row().text(t(locale, "common.menu"), "menu_home");
  await replaceQueueMessage(ctx, text, keyboard);
}

export async function showQueueAttention(ctx: Context, backendDb: BackendDb, config: BackendConfig, page = 0): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const snapshot = createStudioServices(backendDb, config).queue.snapshot(Number(ctx.from?.id));
  const pages = attentionPageCount(snapshot);
  const currentPage = Math.max(0, Math.min(Math.trunc(page), pages - 1));
  const items = pageSlice(snapshot.attention, currentPage, ATTENTION_PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    keyboard.text(`${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  }
  if (pages > 1) {
    if (currentPage > 0) keyboard.text("←", `queue_attention_page:${currentPage - 1}`);
    keyboard.text(`${currentPage + 1}/${pages}`, "queue_attention_page:noop");
    if (currentPage < pages - 1) keyboard.text("→", `queue_attention_page:${currentPage + 1}`);
    keyboard.row();
  }
  keyboard.text(t(locale, "common.back"), "queue_home").text(t(locale, "common.menu"), "menu_home");
  const lines = [`⚠️ *${t(locale, "queue.attention-title")}*`, ""];
  if (!items.length) lines.push(t(locale, "queue.no-attention"));
  else
    for (const item of items)
      lines.push(`• ${formatQueueTime(item.time, locale, config.TIMEZONE)} — ${kindIcon(item.kind)} ${escapeMarkdown(item.label)}`);
  if (pages > 1) lines.push("", t(locale, "queue.page", { page: currentPage + 1, pages }));
  await replaceQueueMessage(ctx, lines.join("\n"), keyboard);
}

export function queueText(snapshot: StudioQueueSnapshot, locale: BotLocale, timeZone: string, page = 0): string {
  const pages = queuePages(snapshot, timeZone);
  const currentPage = Math.max(0, Math.min(Math.trunc(page), pages.length - 1));
  const pageItems = pages[currentPage] ?? { upcoming: [], drafts: [] };
  const lines = [`📋 *${t(locale, "queue.title")}*`, ""];
  if (snapshot.attention.length) lines.push(`⚠️ ${t(locale, "queue.attention-btn", { count: snapshot.attention.length })}`);
  lines.push("", `*${t(locale, "queue.upcoming-heading")}*`);
  if (!pageItems.upcoming.length) lines.push(t(locale, "queue.nothing-scheduled"));
  else {
    let lastDay = "";
    for (const item of pageItems.upcoming) {
      const day = formatter("day-key", locale, timeZone).format(item.time);
      if (day !== lastDay) {
        lines.push("", `*${queueDayLabel(item.time, locale, timeZone)}*`);
        lastDay = day;
      }
      lines.push(`• ${formatQueueTime(item.time, locale, timeZone)} — ${kindIcon(item.kind)} ${escapeMarkdown(item.label)}`);
    }
  }
  lines.push("", `*${t(locale, "queue.drafts-btn", { count: snapshot.drafts.length })}*`);
  if (!pageItems.drafts.length) lines.push(t(locale, "queue.no-drafts"));
  else for (const item of pageItems.drafts) lines.push(`• ${kindIcon(item.kind)} ${escapeMarkdown(item.label)}`);
  if (pages.length > 1) lines.push("", t(locale, "queue.page", { page: currentPage + 1, pages: pages.length }));
  return lines.join("\n");
}

export function queuePageCount(snapshot: StudioQueueSnapshot, timeZone = "UTC"): number {
  return queuePages(snapshot, timeZone).length;
}

function attentionPageCount(snapshot: StudioQueueSnapshot): number {
  return Math.max(1, Math.ceil(snapshot.attention.length / ATTENTION_PAGE_SIZE));
}

function queuePage(snapshot: StudioQueueSnapshot, timeZone: string, page: number): QueuePage {
  return queuePages(snapshot, timeZone)[page] ?? { upcoming: [], drafts: [] };
}

function queuePages(snapshot: StudioQueueSnapshot, timeZone: string): QueuePage[] {
  const pages: QueuePage[] = [];
  let current: QueuePage = { upcoming: [], drafts: [] };
  const flush = () => {
    if (current.upcoming.length || current.drafts.length) pages.push(current);
    current = { upcoming: [], drafts: [] };
  };
  const add = (section: "upcoming" | "drafts", item: StudioQueueItem) => {
    if (current.upcoming.length + current.drafts.length >= QUEUE_PAGE_SIZE) flush();
    current[section].push(item);
  };
  const groups = new Map<string, StudioQueueItem[]>();
  for (const item of snapshot.upcoming) {
    const key = formatter("day-key", "en", timeZone).format(item.time);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const group of groups.values()) {
    if (
      group.length <= QUEUE_PAGE_SIZE &&
      current.upcoming.length + current.drafts.length > 0 &&
      current.upcoming.length + group.length > QUEUE_PAGE_SIZE
    )
      flush();
    for (const item of group) add("upcoming", item);
  }
  for (const item of snapshot.drafts) add("drafts", item);
  flush();
  return pages.length ? pages : [{ upcoming: [], drafts: [] }];
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

function itemCallback(item: Pick<StudioQueueItem | StudioQueueAttentionItem, "id" | "kind">): string {
  return item.kind === "post" ? publicationCallback("post", "preview", [item.id]) : publicationCallback("video", "open", [item.id]);
}

async function replaceQueueMessage(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId && ctx.chat?.id) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (error) {
      if (!isUnchangedMessageEdit(error)) throw error;
    }
  } else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
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

function queueDayLabel(date: Date, locale: BotLocale, timeZone: string): string {
  const dayKey = formatter("day-key", locale, timeZone);
  const today = dayKey.format(new Date());
  const tomorrow = dayKey.format(new Date(Date.now() + 24 * 60 * 60_000));
  const current = dayKey.format(date);
  if (current === today) return t(locale, "common.today");
  if (current === tomorrow) return t(locale, "common.tomorrow");
  return formatter("day", locale, timeZone).format(date);
}
