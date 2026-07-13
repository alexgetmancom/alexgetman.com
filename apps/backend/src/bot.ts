import { eq } from "drizzle-orm";
import { Bot, type Context, InlineKeyboard, Keyboard } from "grammy";
import { audienceAnalysis, creatorDashboard, creatorVideoArchive, creatorVideoMetrics } from "./analytics/creator.js";
import { appendPendingAlbum } from "./bot/albums.js";
import { applyAdminState, getAdminState, handleDraftCallback, sendDraftPreview } from "./bot/callbacks.js";
import { createDraftFromMessage, scheduledDrafts } from "./bot/drafts.js";
import { extractMessage } from "./bot/message.js";
import { showQueue } from "./bot/queue.js";
import { handleVideoCallback, handleVideoMessage, startVideoFlow } from "./bot/video.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { botSettings } from "./db/schema.js";
import { log } from "./logger.js";
import { formatMsk } from "./publishingSchedule.js";
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
    await ctx.reply("Кнопка меню всегда останется внизу чата.", {
      reply_markup: persistentKeyboard(config),
    });
    await showMainMenu(ctx, config);
  });
  bot.hears("☰ Показать меню", (ctx) => showMainMenu(ctx, config));
  bot.hears("⚙️", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await showSettings(ctx, config);
  });
  bot.hears("🎬 Новое видео", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    if (!config.studio.modules.video_posting) return void (await ctx.reply("Видеопубликация выключена в studio.yaml."));
    await startVideoFlow(ctx, backendDb);
  });
  bot.hears("📝 Новый пост", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    await ctx.reply("📝 Пришлите текст с опциональным фото или видео для нового поста.", {
      reply_markup: new InlineKeyboard().text("← Cancel", "cancel_dialog"),
    });
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
    if (state?.action && state.draft_id) return applyAdminState(ctx, backendDb, state.action, state.draft_id, state.control_message_id);
    let textEn = message.text;
    try {
      textEn = await translateToEnglish(message.text, config);
    } catch (error) {
      log("warn", "draft translation failed", { error: String(error) });
      textEn = message.text;
    }
    const draftId = createDraftFromMessage(backendDb, adminId, { ...message, textEn });
    await sendDraftPreview(ctx, backendDb, draftId);
  });
  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.answerCallbackQuery({ text: "Forbidden" }));
    if (ctx.callbackQuery.data === "menu_text") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("📝 Пришлите текст с опциональным фото или видео для нового поста.", {
        reply_markup: new InlineKeyboard().text("← Cancel", "cancel_dialog"),
      });
      return;
    }
    if (ctx.callbackQuery.data === "cancel_dialog") {
      await ctx.answerCallbackQuery();
      try {
        await ctx.deleteMessage();
      } catch {}
      await showMainMenu(ctx, config);
      return;
    }
    if (ctx.callbackQuery.data === "queue_home") {
      await ctx.answerCallbackQuery();
      await showQueue(ctx, backendDb, config);
      return;
    }
    if (ctx.callbackQuery.data === "settings_home") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("⚙️ Настройки", {
        reply_markup: new InlineKeyboard().text("▶️ Подпись YouTube", "settings_youtube_signature").row().text("← К меню", "settings_menu"),
      });
      return;
    }
    if (ctx.callbackQuery.data === "settings_menu") {
      await ctx.answerCallbackQuery();
      await ctx.deleteMessage().catch(() => {});
      await showMainMenu(ctx, config);
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

async function showMainMenu(ctx: Context, config: BackendConfig): Promise<void> {
  const keyboard = new InlineKeyboard();
  if (config.studio.modules.text_posting) keyboard.text("📝 Новый пост", "menu_text");
  if (config.studio.modules.video_posting) keyboard.text("🎬 Новое видео", "video_start");
  keyboard.row();
  keyboard.text("📋 Очередь", "queue_home");
  if (config.studio.modules.analytics) keyboard.text("📊 Статистика", "analytics_home");
  await ctx.reply("Панель управления:", { reply_markup: keyboard });
}

function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  if (!userId) return false;
  return config.ADMIN_IDS.includes(userId);
}

function persistentKeyboard(config: BackendConfig): Keyboard {
  const keyboard = new Keyboard().text("☰ Показать меню");
  if (config.studio.modules.youtube) keyboard.text("⚙️");
  return keyboard.resized().persistent();
}

async function showSettings(ctx: Context, config: BackendConfig): Promise<void> {
  if (!config.studio.modules.youtube) return;
  await ctx.reply("⚙️ Настройки", {
    reply_markup: new InlineKeyboard().text("▶️ Подпись YouTube", "settings_youtube_signature").row().text("← К меню", "settings_menu"),
  });
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
