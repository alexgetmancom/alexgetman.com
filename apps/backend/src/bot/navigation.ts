import { type Context, InlineKeyboard, Keyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { type BotLocale, botLocale, ui } from "./i18n.js";

export function persistentKeyboard(locale: BotLocale = "en"): Keyboard {
  return new Keyboard()
    .text(ui(locale, "☰ Menu", "☰ Меню"))
    .resized()
    .persistent();
}

export async function showMainMenu(ctx: Context, config: BackendConfig, backendDb: BackendDb, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const text = ui(locale, "Control panel:", "Панель управления:");
  const options = { reply_markup: mainMenuKeyboard(config, locale) };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

function mainMenuKeyboard(config: BackendConfig, locale: BotLocale): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (config.studio.modules.text_posting) keyboard.text(ui(locale, "📝 New post", "📝 Новый пост"), "menu_text");
  if (config.studio.modules.video_posting) keyboard.text(ui(locale, "🎬 New video", "🎬 Новое видео"), "video_start");
  keyboard
    .row()
    .text(ui(locale, "📋 Work queue", "📋 Очередь"), "queue_home")
    .text(ui(locale, "🔔 Notifications", "🔔 Уведомления"), "notifications_home");
  if (config.studio.modules.analytics) keyboard.text(ui(locale, "📊 Analytics", "📊 Статистика"), "analytics_home");
  return keyboard.row().text("⚙️", "settings_home");
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
    .text(ui(locale, "🌐 Language", "🌐 Язык"), "settings_language")
    .row()
    .text(ui(locale, "← Menu", "← К меню"), "settings_menu");
}
