import { eq } from "drizzle-orm";
import { Bot, type Context, InlineKeyboard, Keyboard } from "grammy";
import {
  audienceAnalysis,
  creatorPostArchive,
  creatorPostMetrics,
  creatorVideoArchive,
  creatorVideoMetrics,
  studioAnalyticsDashboard,
} from "./analytics/creator.js";
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
  bot.hears(["☰ Меню", "☰ Menu", "☰ Показать меню", "☰ Show menu"], (ctx) => showMainMenu(ctx, config, backendDb));
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
    if (ctx.callbackQuery.data === "queue_drafts") {
      await ctx.answerCallbackQuery();
      await showQueue(ctx, backendDb, config, "drafts");
      return;
    }
    if (ctx.callbackQuery.data === "menu_home") {
      await ctx.answerCallbackQuery();
      await editMainMenu(ctx, config, backendDb);
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
      await editMainMenu(ctx, config, backendDb);
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
      const days = ctx.callbackQuery.data.startsWith("analytics_period:")
        ? Number(ctx.callbackQuery.data.slice("analytics_period:".length))
        : 7;
      await ctx.answerCallbackQuery();
      await showAnalyticsDashboard(ctx, backendDb, config, "overview", analyticsPeriod(days));
      return;
    }
    if (ctx.callbackQuery.data.startsWith("analytics_section:")) {
      const [, sectionValue, daysValue] = ctx.callbackQuery.data.split(":");
      const section = sectionValue === "posts" || sectionValue === "video" ? sectionValue : "overview";
      await ctx.answerCallbackQuery();
      await showAnalyticsDashboard(ctx, backendDb, config, section, analyticsPeriod(Number(daysValue)));
      return;
    }
    if (ctx.callbackQuery.data.startsWith("analytics_archive:")) {
      const offset = Math.max(0, Number(ctx.callbackQuery.data.slice("analytics_archive:".length)) || 0);
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      const archive = creatorVideoArchive(backendDb, offset, locale);
      const keyboard = new InlineKeyboard();
      for (const item of archive.items) keyboard.text(item.label, `analytics_video:${item.id}`).row();
      if (archive.hasMore) keyboard.text(ui(locale, "More", "Ещё"), `analytics_archive:${offset + archive.items.length}`).row();
      keyboard
        .text(ui(locale, "← Video", "← Видеопостинг"), "analytics_section:video:7")
        .row()
        .text(ui(locale, "← Menu", "← Меню"), "menu_home");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(archive.text, { reply_markup: keyboard });
      return;
    }
    if (ctx.callbackQuery.data.startsWith("analytics_video:")) {
      const id = Number(ctx.callbackQuery.data.slice("analytics_video:".length));
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(creatorVideoMetrics(backendDb, id, locale), {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text(ui(locale, "← Archive", "← Архив"), "analytics_archive:0")
          .row()
          .text(ui(locale, "← Menu", "← Меню"), "menu_home"),
      });
      return;
    }
    if (ctx.callbackQuery.data.startsWith("analytics_post_archive:")) {
      const offset = Math.max(0, Number(ctx.callbackQuery.data.slice("analytics_post_archive:".length)) || 0);
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      const archive = creatorPostArchive(backendDb, offset, locale);
      const keyboard = new InlineKeyboard();
      for (const item of archive.items) keyboard.text(item.label, `analytics_post:${item.id}`).row();
      if (archive.hasMore) keyboard.text(ui(locale, "More", "Ещё"), `analytics_post_archive:${offset + archive.items.length}`).row();
      keyboard
        .text(ui(locale, "← Posts", "← Постинг"), "analytics_section:posts:7")
        .row()
        .text(ui(locale, "← Menu", "← Меню"), "menu_home");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(archive.text, { reply_markup: keyboard });
      return;
    }
    if (ctx.callbackQuery.data.startsWith("analytics_post:")) {
      const id = Number(ctx.callbackQuery.data.slice("analytics_post:".length));
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(creatorPostMetrics(backendDb, id, locale), {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text(ui(locale, "← Archive", "← Архив"), "analytics_post_archive:0")
          .row()
          .text(ui(locale, "← Menu", "← Меню"), "menu_home"),
      });
      return;
    }
    if (ctx.callbackQuery.data === "analytics_ai") {
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      await ctx.answerCallbackQuery({ text: ui(locale, "Preparing report…", "Готовлю отчёт…") });
      const report = await audienceAnalysis(backendDb, config, locale);
      await ctx.editMessageText(report, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text(ui(locale, "← Video analytics", "← К статистике видео"), "analytics_section:video:7"),
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
  keyboard.row().text("⚙️", "settings_home");
  await ctx.reply(ui(locale, "Control panel:", "Панель управления:"), { reply_markup: keyboard });
}

function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  if (!userId) return false;
  return config.ADMIN_IDS.includes(userId);
}

function persistentKeyboard(_config: BackendConfig, locale: BotLocale = "en"): Keyboard {
  const keyboard = new Keyboard().text(ui(locale, "☰ Menu", "☰ Меню"));
  return keyboard.resized().persistent();
}

async function editMainMenu(ctx: Context, config: BackendConfig, backendDb: BackendDb): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const keyboard = new InlineKeyboard();
  if (config.studio.modules.text_posting) keyboard.text(ui(locale, "📝 New post", "📝 Новый пост"), "menu_text");
  if (config.studio.modules.video_posting) keyboard.text(ui(locale, "🎬 New video", "🎬 Новое видео"), "video_start");
  keyboard.row().text(ui(locale, "📋 Work queue", "📋 Очередь"), "queue_home");
  if (config.studio.modules.analytics) keyboard.text(ui(locale, "📊 Analytics", "📊 Статистика"), "analytics_home");
  keyboard.row().text("⚙️", "settings_home");
  await ctx.editMessageText(ui(locale, "Control panel:", "Панель управления:"), { reply_markup: keyboard });
}

function analyticsPeriod(value: number): 1 | 7 | 30 {
  return value === 1 || value === 30 ? value : 7;
}

async function showAnalyticsDashboard(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  section: "overview" | "posts" | "video",
  days: 1 | 7 | 30,
): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const dashboard = studioAnalyticsDashboard(backendDb, config, section, days, locale);
  const callback = (nextDays: 1 | 7 | 30) => `analytics_section:${section}:${nextDays}`;
  const keyboard = new InlineKeyboard()
    .text(ui(locale, "Today", "Сегодня"), callback(1))
    .text(ui(locale, "7 days", "7 дней"), callback(7))
    .text(ui(locale, "30 days", "30 дней"), callback(30))
    .row();
  if (section !== "overview") keyboard.text(ui(locale, "📊 Overview", "📊 Общая"), "analytics_section:overview:7");
  if (config.studio.modules.text_posting && section !== "posts")
    keyboard.text(ui(locale, "📝 Posts", "📝 Постинг"), "analytics_section:posts:7");
  if (config.studio.modules.video_posting && section !== "video")
    keyboard.text(ui(locale, "🎬 Video", "🎬 Видеопостинг"), "analytics_section:video:7");
  if (section === "posts") {
    keyboard.row().text(ui(locale, "📚 Post archive", "📚 Архив постов"), "analytics_post_archive:0");
  }
  if (section === "video") {
    keyboard.row().text(ui(locale, "📚 Video archive", "📚 Архив роликов"), "analytics_archive:0");
    if (dashboard.hasComments && config.DEEPSEEK_API_KEY)
      keyboard.text(ui(locale, "🤖 AI audience analysis", "🤖 ИИ-анализ аудитории"), "analytics_ai");
  }
  keyboard.row().text(ui(locale, "← Menu", "← Меню"), "menu_home");
  await ctx.editMessageText(dashboard.text, { parse_mode: "Markdown", reply_markup: keyboard });
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
