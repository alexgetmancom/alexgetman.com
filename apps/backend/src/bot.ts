import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, type Context } from "grammy";
import { handleAnalyticsCallback } from "./bot/analytics-screen.js";
import { runCallbackBoundary } from "./bot/callback-boundary.js";
import { botLocale } from "./bot/i18n.js";
import { persistentKeyboard, showMainMenu } from "./bot/menu-render.js";
import { buildMainMenu } from "./bot/navigation.js";
import { buildNotificationsMenu, notificationsInboxText } from "./bot/notifications-screen.js";
import { handleOperationsCallback } from "./bot/operations-screen.js";
import { handlePostAction } from "./bot/post-actions.js";
import { handlePostMessage, handlePostScreenCallback, startPostScreen } from "./bot/post-screen.js";
import { handleProgressCallback } from "./bot/progress-screen.js";
import { showQueue, showQueueAttention } from "./bot/queue.js";
import { buildSettingsMenu, handleSettingsMessage, showSettings } from "./bot/settings-screen.js";
import { handleVideoActionCallback } from "./bot/video-actions.js";
import { handleVideoConversationMessage, startVideoConversation } from "./bot/video-conversation.js";
import type { BackendDb } from "./db/client.js";
import { actorFromTelegramUser } from "./foundation/actors.js";
import type { BackendConfig } from "./foundation/config.js";
import { t } from "./foundation/i18n/index.js";
import { log } from "./foundation/logger.js";
import { clearTelegramAnalyticsDashboard } from "./interfaces/telegram/control-cards.js";
import { handleTelegramDeliveryPreviewCallback } from "./interfaces/telegram/delivery-previews.js";
import { trackUsageAsync } from "./observability/usage.js";

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
  bot.use((_ctx, next) => trackUsageAsync(backendDb, "telegram.update.handle", next));
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
  bot.use(async (ctx, next) => {
    if (!ctx.callbackQuery?.data) return next();
    await runCallbackBoundary(ctx, backendDb, next);
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
    if (await handleVideoConversationMessage(ctx, backendDb, config)) return;
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
      await showQueue(ctx, backendDb, config);
      return;
    }
    if (ctx.callbackQuery.data === "queue_attention") {
      await ctx.answerCallbackQuery();
      await showQueueAttention(ctx, backendDb, config);
      return;
    }
    if (ctx.callbackQuery.data.startsWith("queue_attention_page:")) {
      const value = ctx.callbackQuery.data.slice("queue_attention_page:".length);
      const page = value === "noop" ? 0 : Number(value);
      await ctx.answerCallbackQuery();
      if (value !== "noop" && Number.isSafeInteger(page) && page >= 0) await showQueueAttention(ctx, backendDb, config, page);
      return;
    }
    if (ctx.callbackQuery.data.startsWith("queue_page:")) {
      const value = ctx.callbackQuery.data.slice("queue_page:".length);
      const page = value === "noop" ? 0 : Number(value);
      await ctx.answerCallbackQuery();
      if (value !== "noop" && Number.isSafeInteger(page) && page >= 0) await showQueue(ctx, backendDb, config, page);
      return;
    }
    // Video notifications link here. Without a branch the tap fell through to
    // the post handler, which read no draft id out of it and answered
    // "invalid post" — an error toast on a button that navigates.
    if (ctx.callbackQuery.data === "notifications_home") {
      await ctx.answerCallbackQuery();
      await ctx.reply(notificationsInboxText(backendDb, config, Number(ctx.from?.id), botLocale(backendDb, Number(ctx.from?.id))), {
        reply_markup: notificationsMenu,
      });
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
    if (await handleVideoActionCallback(ctx, backendDb, config)) return;
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
