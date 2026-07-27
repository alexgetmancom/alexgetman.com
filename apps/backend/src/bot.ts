import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, type Context } from "grammy";
import { handleAnalyticsCallback } from "./bot/analytics-screen.js";
import { botLocale } from "./bot/i18n.js";
import { persistentKeyboard, showMainMenu } from "./bot/menu-render.js";
import { buildMainMenu } from "./bot/navigation.js";
import { buildNotificationsMenu } from "./bot/notifications-screen.js";
import { handleOperationsCallback } from "./bot/operations-screen.js";
import { handlePostAction } from "./bot/post-actions.js";
import { handlePostMessage, handlePostScreenCallback, startPostScreen } from "./bot/post-screen.js";
import { handleProgressCallback } from "./bot/progress-screen.js";
import { showQueue } from "./bot/queue.js";
import { buildSettingsMenu, handleSettingsMessage, showSettings } from "./bot/settings-screen.js";
import { startVideoConversation } from "./bot/video-conversation.js";
import { handleVideoCallback, handleVideoMessage } from "./bot/video-screen.js";
import type { BackendDb } from "./db/client.js";
import { actorFromTelegramUser } from "./foundation/actors.js";
import type { BackendConfig } from "./foundation/config.js";
import { t } from "./foundation/i18n/index.js";
import { log } from "./foundation/logger.js";
import { clearTelegramAnalyticsDashboard } from "./interfaces/telegram/control-cards.js";
import { handleTelegramDeliveryPreviewCallback } from "./interfaces/telegram/delivery-previews.js";

export function createBot(config: BackendConfig, backendDb: BackendDb): Bot | null {
  if (!config.controllerBotToken) {
    log("warn", "Telegram bot token is not configured; bot is disabled");
    return null;
  }
  const bot = new Bot(config.controllerBotToken, { client: { apiRoot: config.TELEGRAM_API_BASE_URL } });
  // Telegram answers 429 with a `retry_after` whenever the admin taps through
  // screens quickly or a media upload hits a flood limit. Without this the
  // rejected call lands in `bot.catch` below and the admin's action is simply
  // lost. Internal server errors are left alone: retrying a 500 blindly can
  // send the same message twice.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30, rethrowInternalServerErrors: true }));
  bindBotHandlers(bot, config, backendDb);
  void bot.api
    .setMyCommands([{ command: "start", description: "Восстановить меню бота" }])
    .then(() => log("info", "Telegram commands menu configured"))
    .catch((error) => log("error", "Failed to configure Telegram commands menu", { error: String(error) }));
  bot.catch((error) => log("error", "grammY handler failed", { error: String(error.error) }));
  return bot;
}

function bindBotHandlers(bot: Bot, config: BackendConfig, backendDb: BackendDb): void {
  const notificationsMenu = buildNotificationsMenu(config, backendDb);
  const settingsMenu = buildSettingsMenu(config, backendDb);
  const mainMenu = buildMainMenu(config, backendDb, settingsMenu, notificationsMenu);
  // The menu plugin installs its own callback_query:data middleware, so the
  // admin gate that used to sit at the top of the single callback handler
  // below must also run in front of it, or a non-admin's tap on a menu
  // button would be processed before ever reaching that check.
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery?.data !== undefined && !isAdmin(config, ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: t(botLocale(backendDb, Number(ctx.from?.id)), "bot.forbidden") });
      return;
    }
    await next();
  });
  bot.use(mainMenu);

  const showBotMenu = async (ctx: Context) => {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply(t(locale, "bot.forbidden")));
    await ctx.reply(t(locale, "start.menu-hint"), {
      reply_markup: persistentKeyboard(locale),
    });
    await showMainMenu(ctx, backendDb, mainMenu);
  };
  bot.command("start", showBotMenu);
  bot.hears(["☰ Меню", "☰ Menu", "☰ Показать меню", "☰ Show menu"], (ctx) => showMainMenu(ctx, backendDb, mainMenu));
  bot.hears("⚙️", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await showSettings(ctx, backendDb, settingsMenu);
  });
  bot.hears(["🎬 Новое видео", "🎬 New video"], async (ctx) => {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply(t(locale, "bot.forbidden")));
    if (!config.studio.modules.video_posting) return void (await ctx.reply(t(locale, "bot.video-disabled")));
    await startVideoConversation(ctx, backendDb);
  });
  bot.hears(["📝 Новый пост", "📝 New post"], async (ctx) => {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply(t(locale, "bot.forbidden")));
    await startPostScreen(ctx, backendDb);
  });
  bot.on("message", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return void (await ctx.reply(t(botLocale(backendDb, Number(ctx.from?.id)), "bot.forbidden")));
    if (await handleSettingsMessage(ctx, backendDb, config, settingsMenu)) return;
    if (await handleVideoMessage(ctx, backendDb, config)) return;
    await handlePostMessage(ctx, backendDb, config);
  });
  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id))
      return void (await ctx.answerCallbackQuery({ text: t(botLocale(backendDb, Number(ctx.from?.id)), "bot.forbidden") }));
    if (await handlePostScreenCallback(ctx, backendDb, mainMenu)) return;
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
      clearTelegramAnalyticsDashboard(backendDb, Number(ctx.from?.id));
      await ctx.answerCallbackQuery();
      await showMainMenu(ctx, backendDb, mainMenu, true);
      return;
    }
    if (await handleProgressCallback(ctx, backendDb, config)) return;
    if (await handleTelegramDeliveryPreviewCallback(ctx, backendDb, config)) return;
    if (await handleAnalyticsCallback(ctx, backendDb, config)) return;
    if (await handleVideoCallback(ctx, backendDb, config)) return;
    if (await handleOperationsCallback(ctx, config)) return;
    await handlePostAction(ctx, backendDb, config);
  });
}

/** Telegram-side gate: does this chat's user resolve to a Studio actor? The bot
 * asks the resolver rather than reading ADMIN_IDS itself, so the credential
 * mapping stays in one place as other interfaces are added. */
export function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  return actorFromTelegramUser(config, userId) !== null;
}
