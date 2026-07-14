import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale, ui } from "./i18n.js";
import { persistentKeyboard, settingsKeyboard, showMainMenu, showSettings } from "./navigation.js";

/** Settings is an interface screen: it owns its callbacks and the small
 * transient input state, keeping the root Telegram router transport-only. */
export async function handleSettingsMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const adminId = Number(ctx.from?.id);
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
  if (!studioServices(backendDb, config).settings.saveYoutubeSignature(adminId, text)) return false;
  const locale = botLocale(backendDb, adminId);
  await ctx.reply(ui(locale, "✅ YouTube signature saved.", "✅ Подпись YouTube сохранена."));
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
  if (data === "settings_youtube_edit") {
    studioServices(backendDb, config).settings.beginYoutubeSignatureEdit(adminId);
    const locale = botLocale(backendDb, adminId);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      ui(
        locale,
        "⌨ Send the persistent text to append to each YouTube description. Send `-` to leave it empty.",
        "⌨ Отправьте постоянный текст для конца YouTube-описания. Чтобы оставить пустым — отправьте «-».",
      ),
    );
    return true;
  }
  if (data === "settings_youtube_clear") {
    studioServices(backendDb, config).settings.clearYoutubeSignature(adminId);
    await ctx.answerCallbackQuery({ text: botLocale(backendDb, adminId) === "ru" ? "Очищено" : "Cleared" });
    await showYouTubeSignature(ctx, backendDb, config, true);
    return true;
  }
  if (data === "settings_language") {
    const locale = botLocale(backendDb, adminId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ui(locale, "🌐 Interface language", "🌐 Язык интерфейса"), {
      reply_markup: new InlineKeyboard()
        .text("English", "settings_language:en")
        .text("Русский", "settings_language:ru")
        .row()
        .text(ui(locale, "← Back", "← Назад"), "settings_home"),
    });
    return true;
  }
  if (data.startsWith("settings_language:")) {
    const locale = data.endsWith(":ru") ? "ru" : "en";
    studioServices(backendDb, config).settings.setLocale(adminId, locale);
    await ctx.answerCallbackQuery({ text: locale === "ru" ? "Язык: русский" : "Language: English" });
    await ctx.editMessageText(locale === "ru" ? "⚙️ Настройки" : "⚙️ Settings", {
      reply_markup: settingsKeyboard(locale, config.studio.modules.youtube),
    });
    await ctx.reply(locale === "ru" ? "Клавиатура обновлена." : "Keyboard updated.", { reply_markup: persistentKeyboard(locale) });
    return true;
  }
  return false;
}

async function showYouTubeSignature(ctx: Context, backendDb: BackendDb, config: BackendConfig, edit = false): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const signature = studioServices(backendDb, config).settings.youtubeSignature(adminId);
  const locale = botLocale(backendDb, adminId);
  const text = ui(
    locale,
    `▶️ *YouTube signature*\n\nThis text is appended to every YouTube description.\n\n*Current:*\n${signature ? escapeMarkdown(signature) : "Not set"}`,
    `▶️ *Подпись YouTube*\n\nЭтот текст автоматически добавляется в конец каждого YouTube-описания.\n\n*Сейчас:*\n${signature ? escapeMarkdown(signature) : "Не задана"}`,
  );
  const keyboard = new InlineKeyboard()
    .text(ui(locale, "✏️ Edit", "✏️ Изменить"), "settings_youtube_edit")
    .text(ui(locale, "🗑 Clear", "🗑 Очистить"), "settings_youtube_clear")
    .row()
    .text(ui(locale, "← Settings", "← К настройкам"), "settings_home");
  if (edit) await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
