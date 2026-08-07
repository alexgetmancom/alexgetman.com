import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { truncateUnicode } from "../foundation/text.js";
import { createStudioServices } from "../studio/services/index.js";
import type { StudioQueueAttentionItem, StudioQueueItem, StudioQueueSnapshot } from "../studio/services/queue.js";
import { botLocale } from "./i18n.js";
import { publicationCallback } from "./publication-callback.js";
import { isUnchangedMessageEdit } from "./telegram-errors.js";

const QUEUE_PAGE_SIZE = 10;
const ATTENTION_PAGE_SIZE = 10;

type QueuePage = { upcoming: StudioQueueItem[]; drafts: StudioQueueItem[] };
type QueueScreen = { text: string; items: QueuePage; currentPage: number; pages: number };

export async function showQueue(ctx: Context, backendDb: BackendDb, config: BackendConfig, page = 0): Promise<void> {
  const actorId = ctx.from?.id;
  if (actorId === undefined) return;
  const locale = botLocale(backendDb, actorId);
  const services = createStudioServices(backendDb, config);
  const timeConfig = services.settings.timeConfig(actorId, config);
  const snapshot = services.queue.snapshot(actorId);
  const keyboard = new InlineKeyboard();
  const { text, items: pageItems, currentPage, pages } = queueScreen(snapshot, locale, timeConfig.TIMEZONE, page);

  for (const item of pageItems.upcoming) keyboard.text(itemButton(item, locale, timeConfig.TIMEZONE), itemCallback(item)).row();
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
  const actorId = ctx.from?.id;
  if (actorId === undefined) return;
  const locale = botLocale(backendDb, actorId);
  const services = createStudioServices(backendDb, config);
  const timeConfig = services.settings.timeConfig(actorId, config);
  const snapshot = services.queue.snapshot(actorId);
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
      lines.push(`• ${formatQueueTime(item.time, locale, timeConfig.TIMEZONE)} — ${kindIcon(item.kind)} ${escapeMarkdown(item.label)}`);
  if (pages > 1) lines.push("", t(locale, "queue.page", { page: currentPage + 1, pages }));
  await replaceQueueMessage(ctx, lines.join("\n"), keyboard);
}

export function queueScreen(snapshot: StudioQueueSnapshot, locale: StudioLocale, timeZone: string, page = 0): QueueScreen {
  const allPages = queuePages(snapshot, timeZone);
  const currentPage = Math.max(0, Math.min(Math.trunc(page), allPages.length - 1));
  const pages = allPages.length;
  const pageItems = allPages[currentPage] ?? { upcoming: [], drafts: [] };
  const lines = [`📋 *${t(locale, "queue.title")}*`, ""];
  if (snapshot.attention.length) lines.push(`⚠️ ${t(locale, "queue.attention-btn", { count: snapshot.attention.length })}`);
  lines.push("", `*${t(locale, "queue.upcoming-heading")}*`);
  if (!pageItems.upcoming.length) lines.push(t(locale, "queue.nothing-scheduled"));
  else {
    let lastDay = "";
    const dayKey = dayKeyFormatter(timeZone);
    for (const item of pageItems.upcoming) {
      const day = dayKey.format(item.time);
      if (day !== lastDay) {
        lines.push("", `*${queueDayLabel(item.time, locale, timeZone)}*`);
        lastDay = day;
      }
      lines.push(`• ${formatQueueTime(item.time, locale, timeZone)} — ${kindIcon(item.kind)} ${escapeMarkdown(item.label)}`);
    }
  }
  lines.push("", `*${t(locale, "queue.drafts-btn", { count: pageItems.drafts.length })}*`);
  if (!pageItems.drafts.length) lines.push(t(locale, "queue.no-drafts"));
  else for (const item of pageItems.drafts) lines.push(`• ${kindIcon(item.kind)} ${escapeMarkdown(item.label)}`);
  if (pages > 1) lines.push("", t(locale, "queue.page", { page: currentPage + 1, pages }));
  return { text: lines.join("\n"), items: pageItems, currentPage, pages };
}

function attentionPageCount(snapshot: StudioQueueSnapshot): number {
  return Math.max(1, Math.ceil(snapshot.attention.length / ATTENTION_PAGE_SIZE));
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
  const dayKey = dayKeyFormatter(timeZone);
  for (const item of snapshot.upcoming) {
    const key = dayKey.format(item.time);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    if (group.length <= QUEUE_PAGE_SIZE && current.upcoming.length > 0 && current.upcoming.length + group.length > QUEUE_PAGE_SIZE) flush();
    for (const item of group) add("upcoming", item);
  }
  for (const item of snapshot.drafts) add("drafts", item);
  flush();
  return pages.length ? pages : [{ upcoming: [], drafts: [] }];
}

function pageSlice<T>(items: T[], page: number, size: number): T[] {
  return items.slice(page * size, (page + 1) * size);
}

function itemButton(item: StudioQueueItem, locale: StudioLocale, timeZone: string): string {
  const targets = item.targets ? ` · ${item.targets} ${t(locale, "queue.platforms-suffix")}` : "";
  return truncateUnicode(`${formatQueueTime(item.time, locale, timeZone)} · ${kindIcon(item.kind)} ${item.label}${targets}`, 60);
}

function kindIcon(kind: StudioQueueItem["kind"]): string {
  return kind === "post" ? "📝" : "🎬";
}

function itemCallback(item: Pick<StudioQueueItem | StudioQueueAttentionItem, "id" | "kind">): string {
  return item.kind === "post"
    ? publicationCallback("post", "view", [item.id, "overview"])
    : publicationCallback("video", "view", [item.id, "overview"]);
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
 * so formatters are built once per cache key and reused. Day keys are a sortable
 * en-CA date that never varies by locale, so they are keyed by zone alone. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(cacheKey: string, create: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;
  const created = create();
  formatterCache.set(cacheKey, created);
  return created;
}

function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  return cachedFormatter(`day-key:${timeZone}`, () => new Intl.DateTimeFormat("en-CA", { timeZone }));
}

function formatter(kind: "clock" | "day", locale: StudioLocale, timeZone: string): Intl.DateTimeFormat {
  const intlLocale = locale === "ru" ? "ru-RU" : "en-GB";
  return cachedFormatter(`${kind}:${locale}:${timeZone}`, () =>
    kind === "clock"
      ? new Intl.DateTimeFormat(intlLocale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone })
      : new Intl.DateTimeFormat(intlLocale, { day: "numeric", month: "short", timeZone }),
  );
}

/** `timeZone` is the actor's own zone resolved by the settings service, falling back
 * to the studio default from config (see foundation/time.ts). */
function formatQueueTime(date: Date, locale: StudioLocale, timeZone: string): string {
  const now = new Date();
  const dayKey = dayKeyFormatter(timeZone);
  const time = formatter("clock", locale, timeZone).format(date);
  if (dayKey.format(date) === dayKey.format(now)) return `${t(locale, "common.today")}, ${time}`;
  if (dayKey.format(date) === dayKey.format(new Date(now.getTime() + 24 * 60 * 60_000))) return `${t(locale, "common.tomorrow")}, ${time}`;
  return `${formatter("day", locale, timeZone).format(date)}, ${time}`;
}

function queueDayLabel(date: Date, locale: StudioLocale, timeZone: string): string {
  const dayKey = dayKeyFormatter(timeZone);
  const today = dayKey.format(new Date());
  const tomorrow = dayKey.format(new Date(Date.now() + 24 * 60 * 60_000));
  const current = dayKey.format(date);
  if (current === today) return t(locale, "common.today");
  if (current === tomorrow) return t(locale, "common.tomorrow");
  return formatter("day", locale, timeZone).format(date);
}
