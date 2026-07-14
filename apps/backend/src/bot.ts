import { Bot, InlineKeyboard } from "grammy";
import { handleAnalyticsCallback } from "./bot/analytics-screen.js";
import { botLocale, ui } from "./bot/i18n.js";
import { persistentKeyboard, showMainMenu, showSettings } from "./bot/navigation.js";
import { handleNotificationsCallback } from "./bot/notifications-screen.js";
import { handleOperationsCallback } from "./bot/operations-screen.js";
import { handlePostAction } from "./bot/post-actions.js";
import { handlePostMessage, handlePostScreenCallback, startPostScreen } from "./bot/post-screen.js";
import { handleProgressCallback } from "./bot/progress-screen.js";
import { showQueue } from "./bot/queue.js";
import { handleSettingsCallback, handleSettingsMessage } from "./bot/settings-screen.js";
import { startVideoConversation } from "./bot/video-conversation.js";
import { handleVideoCallback, handleVideoMessage } from "./bot/video-screen.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { formatMsk } from "./interfaces/telegram/time.js";
import { log } from "./logger.js";
import { studioServices } from "./studio/services/index.js";

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
      reply_markup: persistentKeyboard(locale),
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
    await startVideoConversation(ctx, backendDb);
  });
  bot.hears(["📝 Новый пост", "📝 New post"], async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    await startPostScreen(ctx, backendDb);
  });
  bot.command("pipeline_status", (ctx) => ctx.reply(config.COMMAND_CENTER_URL));
  bot.command("schedule", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    const rows = studioServices(backendDb, config)
      .queue.snapshot(Number(ctx.from?.id))
      .upcoming.filter((item) => item.kind === "post");
    if (rows.length === 0) return void (await ctx.reply("No scheduled drafts."));
    const keyboard = new InlineKeyboard();
    for (const draft of rows) keyboard.text(`#${draft.id} ${formatMsk(draft.time)}`, `schedule:${draft.id}`).row();
    await ctx.reply("Scheduled drafts", { reply_markup: keyboard });
  });
  bot.on("message", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply("Forbidden"));
    if (await handleSettingsMessage(ctx, backendDb, config)) return;
    if (await handleVideoMessage(ctx, backendDb, config)) return;
    await handlePostMessage(ctx, backendDb, config);
  });
  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.answerCallbackQuery({ text: "Forbidden" }));
    if (await handlePostScreenCallback(ctx, backendDb, config)) return;
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
    if (ctx.callbackQuery.data === "queue_attention") {
      await ctx.answerCallbackQuery();
      await showQueue(ctx, backendDb, config, "attention");
      return;
    }
    if (ctx.callbackQuery.data === "menu_home") {
      await ctx.answerCallbackQuery();
      await showMainMenu(ctx, config, backendDb, true);
      return;
    }
    if (await handleProgressCallback(ctx, backendDb, config)) return;
    if (await handleNotificationsCallback(ctx, backendDb, config)) return;
    if (await handleSettingsCallback(ctx, backendDb, config)) return;
    if (await handleAnalyticsCallback(ctx, backendDb, config)) return;
    if (await handleVideoCallback(ctx, backendDb, config)) return;
    if (await handleOperationsCallback(ctx, config)) return;
    await handlePostAction(ctx, backendDb, config);
  });
}

function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  if (!userId) return false;
  return config.ADMIN_IDS.includes(userId);
}
