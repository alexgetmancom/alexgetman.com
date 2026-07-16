import { type Context, InlineKeyboard, Keyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { studioServices } from "../studio/services/index.js";
import { type BotLocale, botLocale, ui } from "./i18n.js";

export function persistentKeyboard(locale: BotLocale = "en"): Keyboard {
  return new Keyboard()
    .text(ui(locale, "☰ Menu", "☰ Меню"))
    .resized()
    .persistent();
}

export async function showMainMenu(ctx: Context, config: BackendConfig, backendDb: BackendDb, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const actorId = Number(ctx.from?.id);
  const queue = studioServices(backendDb, config).queue.snapshot(actorId);
  const unread = studioServices(backendDb, config).notifications.inbox(actorId, 100).length;
  // Telegram does not allow a message consisting only of an inline keyboard.
  // This is deliberately a neutral heading, not a noisy "all clear" status.
  const text = ui(locale, "Control panel", "Панель управления");
  const options = { reply_markup: mainMenuKeyboard(config, locale, queue, unread) };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

function mainMenuKeyboard(
  config: BackendConfig,
  locale: BotLocale,
  queue: { upcoming: unknown[]; drafts: unknown[] },
  unread: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  // Creation is the primary action and deliberately gets its own full row.
  // A video-only Studio (such as Maru) therefore has the compact two-row
  // layout, while a mixed Studio still keeps post and video creation obvious.
  if (config.studio.modules.text_posting) keyboard.text(ui(locale, "📝 New post", "📝 Новый пост"), "menu_text").row();
  if (config.studio.modules.video_posting) keyboard.text(ui(locale, "🎬 New video", "🎬 Новое видео"), "video_start").row();
  keyboard.text(
    ui(
      locale,
      `📋 Work queue${queue.upcoming.length + queue.drafts.length ? ` · ${queue.upcoming.length + queue.drafts.length}` : ""}`,
      `📋 Очередь${queue.upcoming.length + queue.drafts.length ? ` · ${queue.upcoming.length + queue.drafts.length}` : ""}`,
    ),
    "queue_home",
  );
  if (config.studio.modules.analytics) keyboard.text(ui(locale, "📊 Analytics", "📊 Статистика"), "analytics_home");
  keyboard.text(ui(locale, `⚙️ Settings${unread ? ` · 🔴${unread}` : ""}`, `⚙️ Настройки${unread ? ` · 🔴${unread}` : ""}`), "settings_home");
  return keyboard;
}

export async function showSettings(ctx: Context, config: BackendConfig, backendDb: BackendDb, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const text = ui(locale, "⚙️ Settings", "⚙️ Настройки");
  const options = { reply_markup: settingsKeyboard(locale, config.studio.modules.youtube) };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

export function settingsKeyboard(locale: BotLocale, hasYouTube: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (hasYouTube) keyboard.text(ui(locale, "▶️ YouTube signature", "▶️ Подпись YouTube"), "settings_youtube_signature").row();
  return keyboard
    .text(ui(locale, "🔔 Notifications", "🔔 Уведомления"), "notifications_home")
    .row()
    .text(ui(locale, "🔔 Publication notifications", "🔔 Уведомления о публикациях"), "settings_notifications")
    .row()
    .text(ui(locale, "🌐 Language", "🌐 Язык"), "settings_language")
    .row()
    .text(ui(locale, "← Menu", "← К меню"), "settings_menu");
}
