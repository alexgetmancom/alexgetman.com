import { eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { botSettings, botUiSettings } from "../db/schema.js";
import { botLocale, ui } from "./i18n.js";
import { persistentKeyboard, settingsKeyboard, showMainMenu, showSettings } from "./navigation.js";

/** Settings is an interface screen: it owns its callbacks and the small
 * transient input state, keeping the root Telegram router transport-only. */
export async function handleSettingsMessage(ctx: Context, backendDb: BackendDb): Promise<boolean> {
  const adminId = Number(ctx.from?.id);
  const setting = backendDb.db.select().from(botSettings).where(eq(botSettings.adminId, adminId)).get();
  if (setting?.pendingAction !== "youtube_signature") return false;
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
  backendDb.db
    .update(botSettings)
    .set({ youtubeSignature: text === "-" ? "" : text, pendingAction: null, updatedAt: new Date().toISOString() })
    .where(eq(botSettings.adminId, adminId))
    .run();
  const locale = botLocale(backendDb, adminId);
  await ctx.reply(ui(locale, "✅ YouTube signature saved.", "✅ Подпись YouTube сохранена."));
  await showYouTubeSignature(ctx, backendDb);
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
    await showYouTubeSignature(ctx, backendDb, true);
    return true;
  }
  if (data === "settings_youtube_edit") {
    backendDb.db
      .insert(botSettings)
      .values({ adminId, youtubeSignature: "", pendingAction: "youtube_signature", updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: botSettings.adminId, set: { pendingAction: "youtube_signature", updatedAt: new Date().toISOString() } })
      .run();
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
    backendDb.db
      .insert(botSettings)
      .values({ adminId, youtubeSignature: "", pendingAction: null, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: botSettings.adminId,
        set: { youtubeSignature: "", pendingAction: null, updatedAt: new Date().toISOString() },
      })
      .run();
    await ctx.answerCallbackQuery({ text: botLocale(backendDb, adminId) === "ru" ? "Очищено" : "Cleared" });
    await showYouTubeSignature(ctx, backendDb, true);
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
    backendDb.db
      .insert(botUiSettings)
      .values({ adminId, locale, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: botUiSettings.adminId, set: { locale, updatedAt: new Date().toISOString() } })
      .run();
    await ctx.answerCallbackQuery({ text: locale === "ru" ? "Язык: русский" : "Language: English" });
    await ctx.editMessageText(locale === "ru" ? "⚙️ Настройки" : "⚙️ Settings", {
      reply_markup: settingsKeyboard(locale, config.studio.modules.youtube),
    });
    await ctx.reply(locale === "ru" ? "Клавиатура обновлена." : "Keyboard updated.", { reply_markup: persistentKeyboard(locale) });
    return true;
  }
  return false;
}

async function showYouTubeSignature(ctx: Context, backendDb: BackendDb, edit = false): Promise<void> {
  const adminId = Number(ctx.from?.id);
  const signature = backendDb.db.select().from(botSettings).where(eq(botSettings.adminId, adminId)).get()?.youtubeSignature.trim();
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
