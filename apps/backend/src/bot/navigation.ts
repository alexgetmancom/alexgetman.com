import { type Context, InlineKeyboard, Keyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { studioServices } from "../studio/services/index.js";
import { type BotLocale, botLocale } from "./i18n.js";

export function persistentKeyboard(locale: BotLocale = "en"): Keyboard {
  return new Keyboard().text(t(locale, "menu.button")).resized().persistent();
}

export async function showMainMenu(ctx: Context, config: BackendConfig, backendDb: BackendDb, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const actorId = Number(ctx.from?.id);
  const queue = studioServices(backendDb, config).queue.snapshot(actorId);
  const unread = studioServices(backendDb, config).notifications.inbox(actorId, 100).length;
  // Telegram does not allow a message consisting only of an inline keyboard.
  // This is deliberately a neutral heading, not a noisy "all clear" status.
  const text = t(locale, "menu.control-panel");
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
  if (config.studio.modules.text_posting) keyboard.text(t(locale, "menu.new-post"), "menu_text").row();
  if (config.studio.modules.video_posting) keyboard.text(t(locale, "menu.new-video"), "video_start").row();
  const pending = queue.upcoming.length + queue.drafts.length;
  keyboard.text(pending ? t(locale, "menu.work-queue-count", { count: pending }) : t(locale, "menu.work-queue"), "queue_home");
  if (config.studio.modules.analytics) keyboard.text(t(locale, "menu.analytics"), "analytics_home");
  keyboard.text(unread ? t(locale, "menu.settings-unread", { count: unread }) : t(locale, "settings.title"), "settings_home");
  return keyboard;
}

export async function showSettings(ctx: Context, config: BackendConfig, backendDb: BackendDb, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const text = t(locale, "settings.title");
  const options = { reply_markup: settingsKeyboard(locale, config.studio.modules.youtube) };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

export function settingsKeyboard(locale: BotLocale, hasYouTube: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (hasYouTube) keyboard.text(t(locale, "settings.youtube-signature"), "settings_youtube_signature").row();
  return keyboard
    .text(t(locale, "settings.notifications"), "notifications_home")
    .row()
    .text(t(locale, "settings.publication-notifications"), "settings_notifications")
    .row()
    .text(t(locale, "settings.language"), "settings_language")
    .row()
    .text(t(locale, "common.menu"), "settings_menu");
}
