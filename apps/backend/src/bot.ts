import { eq } from "drizzle-orm";
import { Bot, type Context, InlineKeyboard, Keyboard } from "grammy";
import { audienceAnalysis, creatorDashboard, creatorVideoArchive, creatorVideoMetrics } from "./analytics/creator.js";
import { appendPendingAlbum } from "./bot/albums.js";
import {
  applyAdminState,
  clearAdminState,
  getAdminState,
  handleDraftCallback,
  sendDraftPreview,
  startPostDialog,
} from "./bot/callbacks.js";
import { createDraftFromMessage, scheduledDrafts, setDraftControlCard } from "./bot/drafts.js";
import { type BotLocale, botLocale, ui } from "./bot/i18n.js";
import { extractMessage } from "./bot/message.js";
import { showQueue } from "./bot/queue.js";
import { handleVideoCallback, handleVideoMessage, startVideoFlow } from "./bot/video.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { botSettings, botUiSettings } from "./db/schema.js";
import { log } from "./logger.js";
import { formatMsk } from "./publishing/schedule.js";
import { translateToEnglish } from "./translation.js";

export function createBot(config: BackendConfig, backendDb: BackendDb): Bot | null {
  if (!config.controllerBotToken) {
    log("warn", "Telegram bot token is not configured; bot is disabled");
    return null;
  }
  const bot = new Bot(config.controllerBotToken, { client: { apiRoot: config.TELEGRAM_API_BASE_URL } });
  bindBotHandlers(bot, config, backendDb);
  bot.catch((error) => log("error", "grammY handler failed", { error: String(error.error) }));
  return bot;
}

function bindBotHandlers(bot: Bot, config: BackendConfig, backendDb: BackendDb): void {
  bot.command("start", async (ctx) => {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    await ctx.reply(ui(locale, "The menu button stays at the bottom of this chat.", "Кнопка меню всегда останется внизу чата."), {
      reply_markup: persistentKeyboard(config, locale),
    });
    await showMainMenu(ctx, config, backendDb);
  });
  bot.hears(["☰ Показать меню", "☰ Show menu"], (ctx) => showMainMenu(ctx, config, backendDb));
  bot.hears("⚙️", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await showSettings(ctx, config, backendDb);
  });
  bot.hears(["🎬 Новое видео", "🎬 New video"], async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    if (!config.studio.modules.video_posting) return void (await ctx.reply("Видеопубликация выключена в studio.yaml."));
    await startVideoFlow(ctx, backendDb);
  });
  bot.hears(["📝 Новый пост", "📝 New post"], async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    startPostDialog(backendDb, Number(ctx.from?.id));
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    await ctx.reply(
      ui(
        locale,
        "📝 Send text with optional photos or video for a new post.",
        "📝 Пришлите текст с опциональным фото или видео для нового поста.",
      ),
      {
        reply_markup: new InlineKeyboard().text(ui(locale, "← Cancel", "← Отмена"), "cancel_dialog"),
      },
    );
  });
  bot.command("pipeline_status", (ctx) => ctx.reply(config.COMMAND_CENTER_URL));
  bot.command("schedule", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    const rows = scheduledDrafts(backendDb);
    if (rows.length === 0) return void (await ctx.reply("No scheduled drafts."));
    const keyboard = new InlineKeyboard();
    for (const draft of rows)
      keyboard.text(`#${draft.id} ${formatMsk(draft.scheduledAt)} / ${formatMsk(draft.scheduledEnAt)}`, `schedule:${draft.id}`).row();
    await ctx.reply("Scheduled drafts", { reply_markup: keyboard });
  });
  bot.on("message", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    const adminId = Number(ctx.from?.id);
    const setting = backendDb.db.select().from(botSettings).where(eq(botSettings.adminId, adminId)).get();
    if (setting?.pendingAction === "youtube_signature") {
      backendDb.db
        .update(botSettings)
        .set({ youtubeSignature: messageText(ctx), pendingAction: null, updatedAt: new Date().toISOString() })
        .where(eq(botSettings.adminId, adminId))
        .run();
      await ctx.reply("✅ Подпись YouTube сохранена.");
      await showYouTubeSignature(ctx, backendDb);
      return;
    }
    if (await handleVideoMessage(ctx, backendDb, config)) return;
    const state = getAdminState(backendDb, adminId);
    const message = extractMessage(ctx);
    const mediaGroupId = ctx.message && "media_group_id" in ctx.message ? ctx.message.media_group_id : undefined;
    if (mediaGroupId && message.media.length > 0) {
      const media = message.media[0];
      if (!media) return;
      const isNew = appendPendingAlbum(backendDb, {
        adminId,
        chatId: Number(ctx.chat?.id),
        mediaGroupId,
        text: message.text,
        entities: message.entities,
        media,
        action: state?.action ?? null,
        draftId: state?.draft_id ?? null,
      });
      if (isNew) await ctx.reply("Album received. I will create or update the draft in a few seconds.");
      return;
    }
    if (state?.action && state.action !== "new_post" && state.draft_id) {
      try {
        return await applyAdminState(ctx, backendDb, state.action, state.draft_id, state.control_message_id);
      } catch (error) {
        const locale = botLocale(backendDb, adminId);
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reply(
          ui(
            locale,
            `I couldn't use that value: ${message}\n\nPlease try again or tap Cancel.`,
            `Не удалось обработать значение: ${message}\n\nПопробуйте ещё раз или нажмите «Отмена».`,
          ),
        );
        return;
      }
    }
    if (state?.action !== "new_post") {
      const locale = botLocale(backendDb, adminId);
      await ctx.reply(
        ui(locale, "Choose 📝 New post from the menu before sending a new publication.", "Сначала выберите «📝 Новый пост» в меню."),
        {
          reply_markup: persistentKeyboard(config, locale),
        },
      );
      return;
    }
    let textEn = message.text;
    try {
      textEn = await translateToEnglish(message.text, config);
    } catch (error) {
      log("warn", "draft translation failed", { error: String(error) });
      textEn = message.text;
    }
    const draftId = createDraftFromMessage(backendDb, adminId, { ...message, textEn });
    clearAdminState(backendDb, adminId);
    const control = await sendDraftPreview(ctx, backendDb, draftId);
    if (ctx.chat?.id) setDraftControlCard(backendDb, draftId, Number(ctx.chat.id), control.message_id);
  });
  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.answerCallbackQuery({ text: "Forbidden" }));
    if (ctx.callbackQuery.data === "menu_text") {
      await ctx.answerCallbackQuery();
      startPostDialog(backendDb, Number(ctx.from?.id));
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      await ctx.editMessageText(
        ui(
          locale,
          "📝 Send text with optional photos or video for a new post.",
          "📝 Пришлите текст с опциональным фото или видео для нового поста.",
        ),
        {
          reply_markup: new InlineKeyboard().text(ui(locale, "← Cancel", "← Отмена"), "cancel_dialog"),
        },
      );
      return;
    }
    if (ctx.callbackQuery.data === "cancel_dialog") {
      await ctx.answerCallbackQuery();
      clearAdminState(backendDb, Number(ctx.from?.id));
      try {
        await ctx.deleteMessage();
      } catch {}
      await showMainMenu(ctx, config, backendDb);
      return;
    }
    if (ctx.callbackQuery.data === "queue_home") {
      await ctx.answerCallbackQuery();
      await showQueue(ctx, backendDb, config);
      return;
    }
    if (
      ctx.callbackQuery.data === "queue_upcoming" ||
      ctx.callbackQuery.data === "queue_drafts" ||
      ctx.callbackQuery.data === "queue_attention"
    ) {
      await ctx.answerCallbackQuery();
      await showQueue(ctx, backendDb, config, ctx.callbackQuery.data.slice("queue_".length) as "upcoming" | "drafts" | "attention");
      return;
    }
    if (ctx.callbackQuery.data.startsWith("progress:")) {
      const draftId = Number(ctx.callbackQuery.data.slice("progress:".length));
      const { postProgress } = await import("./bot/progress.js");
      const progress = postProgress(backendDb, draftId);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(progress.text, { parse_mode: "Markdown", reply_markup: progress.keyboard });
      return;
    }
    if (ctx.callbackQuery.data.startsWith("progress_details:")) {
      const draftId = Number(ctx.callbackQuery.data.slice("progress_details:".length));
      const { postProgress } = await import("./bot/progress.js");
      const progress = postProgress(backendDb, draftId, true);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(progress.text, { parse_mode: "Markdown", reply_markup: progress.keyboard });
      return;
    }
    if (ctx.callbackQuery.data.startsWith("progress_cancel:")) {
      const draftId = Number(ctx.callbackQuery.data.slice("progress_cancel:".length));
      const { cancelRemainingPostJobs, postProgress } = await import("./bot/progress.js");
      cancelRemainingPostJobs(backendDb, draftId);
      const progress = postProgress(backendDb, draftId);
      await ctx.answerCallbackQuery({ text: "Remaining work cancelled" });
      await ctx.editMessageText(progress.text, { parse_mode: "Markdown", reply_markup: progress.keyboard });
      return;
    }
    if (ctx.callbackQuery.data === "settings_home") {
      await ctx.answerCallbackQuery();
      await showSettings(ctx, config, backendDb, true);
      return;
    }
    if (ctx.callbackQuery.data === "settings_menu") {
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => {});
      await showMainMenu(ctx, config, backendDb);
      return;
    }
    if (ctx.callbackQuery.data === "settings_youtube_signature") {
      await ctx.answerCallbackQuery();
      await showYouTubeSignature(ctx, backendDb, true);
      return;
    }
    if (ctx.callbackQuery.data === "settings_youtube_edit") {
      const adminId = Number(ctx.from?.id);
      backendDb.db
        .insert(botSettings)
        .values({ adminId, youtubeSignature: "", pendingAction: "youtube_signature", updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: botSettings.adminId,
          set: { pendingAction: "youtube_signature", updatedAt: new Date().toISOString() },
        })
        .run();
      await ctx.answerCallbackQuery();
      await ctx.reply("⌨ Отправьте новый постоянный текст для конца YouTube-описания. Чтобы оставить пустым — отправьте «-».");
      return;
    }
    if (ctx.callbackQuery.data === "settings_youtube_clear") {
      const adminId = Number(ctx.from?.id);
      backendDb.db
        .insert(botSettings)
        .values({ adminId, youtubeSignature: "", pendingAction: null, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: botSettings.adminId,
          set: { youtubeSignature: "", pendingAction: null, updatedAt: new Date().toISOString() },
        })
        .run();
      await ctx.answerCallbackQuery({ text: "Очищено" });
      await showYouTubeSignature(ctx, backendDb, true);
      return;
    }
    if (ctx.callbackQuery.data === "settings_language") {
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(ui(locale, "🌐 Interface language", "🌐 Язык интерфейса"), {
        reply_markup: new InlineKeyboard()
          .text("English", "settings_language:en")
          .text("Русский", "settings_language:ru")
          .row()
          .text(ui(locale, "← Back", "← Назад"), "settings_home"),
      });
      return;
    }
    if (ctx.callbackQuery.data.startsWith("settings_language:")) {
      const locale = ctx.callbackQuery.data.endsWith(":ru") ? "ru" : "en";
      const adminId = Number(ctx.from?.id);
      backendDb.db
        .insert(botUiSettings)
        .values({ adminId, locale, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({ target: botUiSettings.adminId, set: { locale, updatedAt: new Date().toISOString() } })
        .run();
      await ctx.answerCallbackQuery({ text: locale === "ru" ? "Язык: русский" : "Language: English" });
      await ctx.editMessageText(locale === "ru" ? "⚙️ Настройки" : "⚙️ Settings", {
        reply_markup: settingsKeyboard(locale),
      });
      await ctx.reply(locale === "ru" ? "Клавиатура обновлена." : "Keyboard updated.", {
        reply_markup: persistentKeyboard(config, locale),
      });
      return;
    }
    if (
      ctx.callbackQuery.data === "analytics_home" ||
      ctx.callbackQuery.data === "analytics_total" ||
      ctx.callbackQuery.data.startsWith("analytics_period:")
    ) {
      let days = 7;
      if (ctx.callbackQuery.data === "analytics_total") {
        days = 0;
      } else if (ctx.callbackQuery.data.startsWith("analytics_period:")) {
        days = Number(ctx.callbackQuery.data.slice("analytics_period:".length));
      }
      const dashboard = creatorDashboard(backendDb, config, [0, 1, 7, 30].includes(days) ? days : 7);
      const keyboard = new InlineKeyboard()
        .text("Сегодня", "analytics_period:1")
        .text("7 дней", "analytics_period:7")
        .text("30 дней", "analytics_period:30")
        .row()
        .text("📊 Общая", "analytics_total");
      if (dashboard.hasComments && config.DEEPSEEK_API_KEY) {
        keyboard.text("🤖 ИИ-анализ аудитории", "analytics_ai");
      }
      keyboard.row().text("📚 Архив роликов", "analytics_archive:0");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(dashboard.text, { parse_mode: "Markdown", reply_markup: keyboard });
      return;
    }
    if (ctx.callbackQuery.data.startsWith("analytics_archive:")) {
      const offset = Math.max(0, Number(ctx.callbackQuery.data.slice("analytics_archive:".length)) || 0);
      const archive = creatorVideoArchive(backendDb, offset);
      const keyboard = new InlineKeyboard();
      for (const item of archive.items) keyboard.text(item.label, `analytics_video:${item.id}`).row();
      if (archive.hasMore) keyboard.text("Ещё", `analytics_archive:${offset + archive.items.length}`).row();
      keyboard.text("← К статистике", "analytics_home");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(archive.text, { reply_markup: keyboard });
      return;
    }
    if (ctx.callbackQuery.data.startsWith("analytics_video:")) {
      const id = Number(ctx.callbackQuery.data.slice("analytics_video:".length));
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(creatorVideoMetrics(backendDb, id), {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("← К архиву", "analytics_archive:0"),
      });
      return;
    }
    if (ctx.callbackQuery.data === "analytics_ai") {
      await ctx.answerCallbackQuery({ text: "Готовлю отчёт…" });
      const report = await audienceAnalysis(backendDb, config);
      await ctx.editMessageText(report, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("← К статистике", "analytics_home"),
      });
      return;
    }
    if (await handleVideoCallback(ctx, backendDb, config)) return;
    await handleDraftCallback(ctx, backendDb, config);
  });
}

async function showMainMenu(ctx: Context, config: BackendConfig, backendDb: BackendDb): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const keyboard = new InlineKeyboard();
  if (config.studio.modules.text_posting) keyboard.text(ui(locale, "📝 New post", "📝 Новый пост"), "menu_text");
  if (config.studio.modules.video_posting) keyboard.text(ui(locale, "🎬 New video", "🎬 Новое видео"), "video_start");
  keyboard.row();
  keyboard.text(ui(locale, "📋 Work queue", "📋 Очередь"), "queue_home");
  if (config.studio.modules.analytics) keyboard.text(ui(locale, "📊 Analytics", "📊 Статистика"), "analytics_home");
  await ctx.reply(ui(locale, "Control panel:", "Панель управления:"), { reply_markup: keyboard });
}

function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  if (!userId) return false;
  return config.ADMIN_IDS.includes(userId);
}

function persistentKeyboard(config: BackendConfig, locale: BotLocale = "en"): Keyboard {
  const keyboard = new Keyboard().text(ui(locale, "☰ Show menu", "☰ Показать меню"));
  if (config.studio.modules.youtube) keyboard.text("⚙️");
  return keyboard.resized().persistent();
}

async function showSettings(ctx: Context, config: BackendConfig, backendDb: BackendDb, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const text = ui(locale, "⚙️ Settings", "⚙️ Настройки");
  if (edit) await ctx.editMessageText(text, { reply_markup: settingsKeyboard(locale, config.studio.modules.youtube) });
  else await ctx.reply(text, { reply_markup: settingsKeyboard(locale, config.studio.modules.youtube) });
}

function settingsKeyboard(locale: BotLocale, hasYouTube = true): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (hasYouTube) keyboard.text(ui(locale, "▶️ YouTube signature", "▶️ Подпись YouTube"), "settings_youtube_signature").row();
  return keyboard
    .text(ui(locale, "🌐 Language", "🌐 Язык"), "settings_language")
    .row()
    .text(ui(locale, "← Menu", "← К меню"), "settings_menu");
}

async function showYouTubeSignature(ctx: Context, backendDb: BackendDb, edit = false): Promise<void> {
  const signature = backendDb.db
    .select()
    .from(botSettings)
    .where(eq(botSettings.adminId, Number(ctx.from?.id)))
    .get()
    ?.youtubeSignature.trim();
  const text = `▶️ *Подпись YouTube*\n\nЭтот текст автоматически добавляется в конец каждого YouTube-описания.\n\n*Сейчас:*\n${signature ? escapeMarkdown(signature) : "Не задана"}`;
  const keyboard = new InlineKeyboard()
    .text("✏️ Изменить", "settings_youtube_edit")
    .text("🗑 Очистить", "settings_youtube_clear")
    .row()
    .text("← К настройкам", "settings_home");
  if (edit) await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  else await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

function messageText(ctx: Context): string {
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
  return text === "-" ? "" : text;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
