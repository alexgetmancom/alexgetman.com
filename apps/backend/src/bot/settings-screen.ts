import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";
import { persistentKeyboard, settingsKeyboard, showMainMenu, showSettings } from "./navigation.js";

/** Settings is an interface screen: it owns its callbacks and the small
 * transient input state, keeping the root Telegram router transport-only. */
export async function handleSettingsMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const adminId = Number(ctx.from?.id);
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
  if (!studioServices(backendDb, config).settings.saveYoutubeSignature(adminId, text)) return false;
  const locale = botLocale(backendDb, adminId);
  await ctx.reply(t(locale, "settings.youtube-saved"));
  await showYouTubeSignature(ctx, backendDb, config);
  return true;
}

export async function handleSettingsCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const adminId = Number(ctx.from?.id);
  if (data === "settings_home") {
    await ctx.answerCallbackQuery();
    await showSettings(ctx, config, backendDb, true);
    return true;
  }
  if (data === "settings_menu") {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx, config, backendDb, true);
    return true;
  }
  if (data === "settings_youtube_signature") {
    await ctx.answerCallbackQuery();
    await showYouTubeSignature(ctx, backendDb, config, true);
    return true;
  }
  if (data === "settings_notifications") {
    await ctx.answerCallbackQuery();
    await showNotificationSettings(ctx, backendDb, config, true);
    return true;
  }
  if (data === "settings_notifications_reminders") {
    const current = studioServices(backendDb, config).settings.notifications(adminId);
    studioServices(backendDb, config).settings.setNotifications(adminId, { remindersEnabled: !current.remindersEnabled });
    await ctx.answerCallbackQuery();
    await showNotificationSettings(ctx, backendDb, config, true);
    return true;
  }
  if (data === "settings_notifications_completion") {
    const current = studioServices(backendDb, config).settings.notifications(adminId);
    studioServices(backendDb, config).settings.setNotifications(adminId, { completionEnabled: !current.completionEnabled });
    await ctx.answerCallbackQuery();
    await showNotificationSettings(ctx, backendDb, config, true);
    return true;
  }
  if (data.startsWith("settings_notifications_minutes:")) {
    const minutes = Number(data.slice("settings_notifications_minutes:".length));
    studioServices(backendDb, config).settings.setNotifications(adminId, { reminderMinutes: minutes });
    await ctx.answerCallbackQuery({ text: t(botLocale(backendDb, adminId), "settings.minutes-toast", { minutes }) });
    await showNotificationSettings(ctx, backendDb, config, true);
    return true;
  }
  if (data === "settings_youtube_edit") {
    studioServices(backendDb, config).settings.beginYoutubeSignatureEdit(adminId);
    const locale = botLocale(backendDb, adminId);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(locale, "settings.youtube-edit-prompt"));
    return true;
  }
  if (data === "settings_youtube_clear") {
    studioServices(backendDb, config).settings.clearYoutubeSignature(adminId);
    await ctx.answerCallbackQuery({ text: t(botLocale(backendDb, adminId), "settings.cleared") });
    await showYouTubeSignature(ctx, backendDb, config, true);
    return true;
  }
  if (data === "settings_language") {
    const locale = botLocale(backendDb, adminId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t(locale, "settings.language-title"), {
      reply_markup: new InlineKeyboard()
        .text("English", "settings_language:en")
        .text("Русский", "settings_language:ru")
        .row()
        .text(t(locale, "common.back"), "settings_home"),
    });
    return true;
  }
  if (data.startsWith("settings_language:")) {
    const locale = data.endsWith(":ru") ? "ru" : "en";
    studioServices(backendDb, config).settings.setLocale(adminId, locale);
    await ctx.answerCallbackQuery({ text: t(locale, "settings.language-set") });
    await ctx.editMessageText(t(locale, "settings.title"), {
      reply_markup: settingsKeyboard(locale, config.studio.modules.youtube),
    });
    await ctx.reply(t(locale, "settings.keyboard-updated"), { reply_markup: persistentKeyboard(locale) });
    return true;
  }
  return false;
}

async function showNotificationSettings(ctx: Context, backendDb: BackendDb, config: BackendConfig, edit = false): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, adminId);
  const settings = studioServices(backendDb, config).settings.notifications(adminId);
  const on = (value: boolean) => (value ? t(locale, "settings.on") : t(locale, "settings.off"));
  const text = t(locale, "settings.notif-body", {
    reminders: on(settings.remindersEnabled),
    minutes: settings.reminderMinutes,
    completion: on(settings.completionEnabled),
  });
  const keyboard = new InlineKeyboard()
    .text(`${settings.remindersEnabled ? "✅" : "◻️"} ${t(locale, "settings.reminder-label")}`, "settings_notifications_reminders")
    .text(`${settings.completionEnabled ? "✅" : "◻️"} ${t(locale, "settings.completion-label")}`, "settings_notifications_completion")
    .row()
    .text("1", "settings_notifications_minutes:1")
    .text("5", "settings_notifications_minutes:5")
    .text("10", "settings_notifications_minutes:10")
    .text("15", "settings_notifications_minutes:15")
    .text("30", "settings_notifications_minutes:30")
    .row()
    .text(t(locale, "settings.back-to-settings"), "settings_home");
  if (edit) await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

async function showYouTubeSignature(ctx: Context, backendDb: BackendDb, config: BackendConfig, edit = false): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const signature = studioServices(backendDb, config).settings.youtubeSignature(adminId);
  const locale = botLocale(backendDb, adminId);
  const text = t(locale, "settings.youtube-body", {
    signature: signature ? escapeMarkdown(signature) : t(locale, "settings.youtube-not-set"),
  });
  const keyboard = new InlineKeyboard()
    .text(t(locale, "settings.edit"), "settings_youtube_edit")
    .text(t(locale, "settings.clear"), "settings_youtube_clear")
    .row()
    .text(t(locale, "settings.back-to-settings"), "settings_home");
  if (edit) await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
