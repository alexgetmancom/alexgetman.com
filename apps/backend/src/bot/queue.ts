import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { studioServices } from "../studio/services/index.js";
import type { StudioQueueItem, StudioQueueSnapshot } from "../studio/services/queue.js";
import { type BotLocale, botLocale, ui } from "./i18n.js";

type QueueView = "upcoming" | "drafts";

export async function showQueue(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  requestedView: QueueView = "upcoming",
): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const snapshot = studioServices(backendDb, config).queue.snapshot(Number(ctx.from?.id));
  // Queue opens as a quiet operational overview. Draft history is opt-in,
  // rather than becoming a wall of old cards whenever nothing is scheduled.
  const view = requestedView;
  const keyboard = new InlineKeyboard();
  let text = upcomingText(snapshot, locale);

  if (view === "upcoming") {
    text = upcomingText(snapshot, locale);
    for (const item of snapshot.upcoming) keyboard.text(itemButton(item, locale), itemCallback(item)).row();
  } else if (view === "drafts") {
    text = draftsText(snapshot, locale);
    for (const item of snapshot.drafts) keyboard.text(`${kindIcon(item.kind)} ${item.label}`, itemCallback(item)).row();
  }

  if (view !== "upcoming") keyboard.text(ui(locale, "📅 Upcoming", "📅 Ближайшие"), "queue_home");
  if (view !== "drafts")
    keyboard.text(ui(locale, `🟡 Drafts (${snapshot.drafts.length})`, `🟡 Черновики (${snapshot.drafts.length})`), "queue_drafts");
  keyboard.row().text(ui(locale, "← Menu", "← Меню"), "menu_home");
  await replaceQueueMessage(ctx, text, keyboard);
}

function upcomingText(snapshot: StudioQueueSnapshot, locale: BotLocale): string {
  const lines = [`📋 *${ui(locale, "Work queue", "Очередь")}*`, "", `*${ui(locale, "Upcoming", "Ближайшие публикации")}*`];
  if (!snapshot.upcoming.length) lines.push(ui(locale, "Nothing is scheduled.", "Ничего не запланировано."));
  else
    for (const item of snapshot.upcoming.slice(0, 5))
      lines.push(`• ${formatQueueTime(item.time, locale)} — ${kindIcon(item.kind)} ${item.label}`);
  lines.push("", `🟡 ${ui(locale, "Drafts", "Черновики")}: ${snapshot.drafts.length}`);
  return lines.join("\n");
}

function draftsText(snapshot: StudioQueueSnapshot, locale: BotLocale): string {
  const lines = [`🟡 *${ui(locale, "Drafts", "Черновики")}*`];
  if (!snapshot.drafts.length)
    lines.push(`\n${ui(locale, "No drafts. Start a post or video from the menu.", "Черновиков нет. Начните пост или видео из меню.")}`);
  else lines.push(`\n${ui(locale, "Choose a draft to continue:", "Выберите черновик, чтобы продолжить:")}`);
  return lines.join("\n");
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
