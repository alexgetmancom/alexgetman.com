import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { studioServices } from "../studio/services/index.js";
import type { StudioQueueItem, StudioQueueSnapshot } from "../studio/services/queue.js";
import { type BotLocale, botLocale, ui } from "./i18n.js";

type QueueView = "upcoming" | "drafts" | "attention";

export async function showQueue(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  requestedView: QueueView = "upcoming",
): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const snapshot = studioServices(backendDb, config).queue.snapshot(Number(ctx.from?.id));
  const view = requestedView === "upcoming" && snapshot.upcoming.length === 0 ? "drafts" : requestedView;
  const keyboard = new InlineKeyboard();
  let text: string;

  if (view === "upcoming") {
    text = upcomingText(snapshot, locale);
    for (const item of snapshot.upcoming) keyboard.text(itemButton(item, locale), itemCallback(item)).row();
  } else if (view === "drafts") {
    text = draftsText(snapshot, locale);
    for (const item of snapshot.drafts) keyboard.text(`${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  } else {
    text = attentionText(snapshot, locale);
    for (const item of snapshot.attention) keyboard.text(`${kindIcon(item.kind)} ${item.label}`, attentionCallback(item)).row();
  }

  if (view !== "upcoming" && snapshot.upcoming.length) keyboard.text(ui(locale, "📅 Upcoming", "📅 Ближайшие"), "queue_home");
  if (view !== "drafts")
    keyboard.text(ui(locale, `🟡 Drafts (${snapshot.drafts.length})`, `🟡 Черновики (${snapshot.drafts.length})`), "queue_drafts");
  if (view !== "attention" && snapshot.attention.length)
    keyboard.text(
      ui(locale, `⚠️ Needs attention (${snapshot.attention.length})`, `⚠️ Требует внимания (${snapshot.attention.length})`),
      "queue_attention",
    );
  keyboard.row().text(ui(locale, "← Menu", "← Меню"), "menu_home");
  await replaceQueueMessage(ctx, text, keyboard);
}

function upcomingText(snapshot: StudioQueueSnapshot, locale: BotLocale): string {
  const lines = [`📋 *${ui(locale, "Work queue", "Очередь")}*`, "", `*${ui(locale, "Upcoming", "Ближайшие публикации")}*`];
  for (const item of snapshot.upcoming.slice(0, 5))
    lines.push(`• ${formatQueueTime(item.time, locale)} — ${kindIcon(item.kind)} ${item.label}`);
  lines.push("", summary(snapshot, locale));
  return lines.join("\n");
}

function draftsText(snapshot: StudioQueueSnapshot, locale: BotLocale): string {
  const lines = [`🟡 *${ui(locale, "Drafts", "Черновики")}*`];
  if (!snapshot.drafts.length)
    lines.push(`\n${ui(locale, "No drafts. Start a post or video from the menu.", "Черновиков нет. Начните пост или видео из меню.")}`);
  else lines.push(`\n${ui(locale, "Choose a draft to continue:", "Выберите черновик, чтобы продолжить:")}`);
  return lines.join("\n");
}

function attentionText(snapshot: StudioQueueSnapshot, locale: BotLocale): string {
  const lines = [`⚠️ *${ui(locale, "Needs attention", "Требует внимания")}*`];
  if (!snapshot.attention.length) lines.push(`\n${ui(locale, "Everything is on track.", "Всё идёт по плану.")}`);
  else lines.push(`\n${ui(locale, "Open an item to see its failed targets.", "Откройте пункт, чтобы увидеть площадки с ошибкой.")}`);
  return lines.join("\n");
}

function summary(snapshot: StudioQueueSnapshot, locale: BotLocale): string {
  const draftsLabel = ui(locale, "Drafts", "Черновики");
  const attentionLabel = ui(locale, "needs attention", "требует внимания");
  return `🟡 ${draftsLabel}: ${snapshot.drafts.length}${snapshot.attention.length ? ` · ⚠️ ${attentionLabel}: ${snapshot.attention.length}` : ""}`;
}

function itemButton(item: StudioQueueItem, locale: BotLocale): string {
  const targets = item.targets ? ` · ${item.targets} ${ui(locale, "platforms", "площадок")}` : "";
  return `${formatQueueTime(item.time, locale)} · ${kindIcon(item.kind)} ${item.label}${targets}`.slice(0, 60);
}

function kindIcon(kind: StudioQueueItem["kind"]): string {
  return kind === "post" ? "📝" : "🎬";
}

function itemCallback(item: StudioQueueItem): string {
  return item.kind === "post" ? `preview:${item.id}` : `video_open:${item.id}`;
}

function attentionCallback(item: { id: number; kind: StudioQueueItem["kind"] }): string {
  return item.kind === "post" ? `progress_details:${item.id}` : `video_open:${item.id}`;
}

async function replaceQueueMessage(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId && ctx.chat?.id)
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

function formatQueueTime(date: Date, locale: BotLocale): string {
  const now = new Date();
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(date);
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(now);
  const tomorrowKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date(now.getTime() + 24 * 60 * 60_000));
  const time = new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Moscow",
  }).format(date);
  if (dateKey === todayKey) return `${ui(locale, "Today", "Сегодня")}, ${time}`;
  if (dateKey === tomorrowKey) return `${ui(locale, "Tomorrow", "Завтра")}, ${time}`;
  const day = new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Moscow",
  }).format(date);
  return `${day}, ${time}`;
}
