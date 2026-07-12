import { Bot, type Context, InlineKeyboard, Keyboard } from "grammy";
import { audienceAnalysis, creatorDashboard } from "./analytics/creator.js";
import { appendPendingAlbum } from "./bot/albums.js";
import { applyAdminState, getAdminState, handleDraftCallback, sendDraftPreview } from "./bot/callbacks.js";
import { createDraftFromMessage, scheduledDrafts } from "./bot/drafts.js";
import { extractMessage } from "./bot/message.js";
import { handleVideoCallback, handleVideoMessage, startVideoFlow } from "./bot/video.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
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
      reply_markup: new Keyboard().text("☰ Показать меню").resized().persistent(),
    });
    await showMainMenu(ctx, config);
  });
  bot.hears("☰ Показать меню", (ctx) => showMainMenu(ctx, config));
  bot.hears("🎬 Видеопубликация", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    if (!config.studio.modules.video_posting) return void (await ctx.reply("Видеопубликация выключена в studio.yaml."));
    await startVideoFlow(ctx, backendDb);
  });
  bot.hears("📝 Обычная публикация", (ctx) => ctx.reply("Пришлите текст с опциональным фото или видео для обычной публикации."));
  bot.command("pipeline_status", (ctx) => ctx.reply(`${config.COMMAND_CENTER_URL.replace(/\/$/, "")}/pipeline-status`));
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
      textEn = "";
    }
    const draftId = createDraftFromMessage(backendDb, adminId, { ...message, textEn });
    await sendDraftPreview(ctx, backendDb, draftId);
  });
  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.answerCallbackQuery({ text: "Forbidden" }));
    if (ctx.callbackQuery.data === "menu_text") {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("📝 Пришлите текст с опциональным фото или видео для обычной публикации.");
      return;
    }
    if (ctx.callbackQuery.data === "analytics_home" || ctx.callbackQuery.data.startsWith("analytics_period:")) {
      const days = ctx.callbackQuery.data === "analytics_home" ? 7 : Number(ctx.callbackQuery.data.slice("analytics_period:".length));
      const dashboard = creatorDashboard(backendDb, config, [1, 7, 30].includes(days) ? days : 7);
      const keyboard = new InlineKeyboard()
        .text("Сегодня", "analytics_period:1")
        .text("7 дней", "analytics_period:7")
        .text("30 дней", "analytics_period:30");
      if (dashboard.hasComments && config.DEEPSEEK_API_KEY) keyboard.row().text("🤖 ИИ-анализ аудитории", "analytics_ai");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(dashboard.text, { parse_mode: "Markdown", reply_markup: keyboard });
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
  if (config.studio.modules.text_posting) keyboard.text("📝 Обычная публикация", "menu_text");
  if (config.studio.modules.video_posting) keyboard.text("🎬 Видеопубликация", "video_start");
  if (config.studio.modules.analytics) keyboard.row().text("📊 Статистика", "analytics_home");
  await ctx.reply("Панель управления:", { reply_markup: keyboard });
}

function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  if (!userId) return false;
  return config.ADMIN_IDS.length === 0 || config.ADMIN_IDS.includes(userId);
}
