import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, type Context, InlineKeyboard } from "grammy";
import { handleAnalyticsCallback } from "./bot/analytics-screen.js";
import { runCallbackBoundary } from "./bot/callback-boundary.js";
import { handleActivePublicationMessage, handlePublicationCallback } from "./bot/callback-router.js";
import { botLocale } from "./bot/i18n.js";
import { persistentKeyboard, showMainMenu } from "./bot/menu-render.js";
import { buildMainMenu } from "./bot/navigation.js";
import { buildNotificationsMenu, notificationsInboxText } from "./bot/notifications-screen.js";
import { handleOperationsCallback } from "./bot/operations-screen.js";
import { handlePostMessage, handlePostScreenCallback, startPostScreen } from "./bot/post-screen.js";
import { handleProgressCallback } from "./bot/progress-screen.js";
import { showQueue, showQueueAttention } from "./bot/queue.js";
import { PUBLICATION_ACTIONS, parsePublicationCallback, parseSessionCallback } from "./bot/session-fsm.js";
import { buildSettingsMenu, handleSettingsMessage, showSettings } from "./bot/settings-screen.js";
import { startVideoConversation } from "./bot/video-conversation.js";
import type { BackendDb } from "./db/client.js";
import { actorFromTelegramUser } from "./foundation/actors.js";
import type { BackendConfig } from "./foundation/config.js";
import { type MessageKey, t } from "./foundation/i18n/index.js";
import type { StudioLocale } from "./foundation/locale.js";
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
    .setMyCommands([{ command: "start", description: t("en", "bot.command-start") }])
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
      await ctx.answerCallbackQuery();
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
    if (!isAdmin(config, ctx.from?.id)) return;
    await ctx.reply(t(locale, "start.menu-hint"), {
      reply_markup: persistentKeyboard(locale),
    });
    await showMainMenu(ctx, backendDb, mainMenu);
  };
  bot.command("start", showBotMenu);
  bot.hears(localizedTextVariants(["menu.button", "menu.button-legacy"]), async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await showMainMenu(ctx, backendDb, mainMenu);
  });
  bot.hears("⚙️", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await showSettings(ctx, backendDb, settingsMenu);
  });
  bot.hears(localizedTextVariants(["menu.new-video"]), async (ctx) => {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    if (!isAdmin(config, ctx.from?.id)) return;
    if (!config.studio.modules.video_posting) return void (await ctx.reply(t(locale, "bot.video-disabled")));
    await startVideoConversation(ctx, backendDb);
  });
  bot.hears(localizedTextVariants(["menu.new-post"]), async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await startPostScreen(ctx, backendDb);
  });
  bot.on("message", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    if (await handleSettingsMessage(ctx, backendDb, config, settingsMenu)) return;
    if (await handleActivePublicationMessage(ctx, backendDb, config)) return;
    await handlePostMessage(ctx, backendDb, config);
  });

  const callbackRoutes: CallbackRoute[] = [
    {
      name: "post-screen",
      matches: (data) => data === "menu_text" || data === "cancel_dialog",
      handle: async (ctx) => handlePostScreenCallback(ctx, backendDb, mainMenu),
    },
    {
      name: "queue",
      matches: (data) => data === "queue_home" || data === "queue_drafts",
      handle: async (ctx) => {
        await ctx.answerCallbackQuery();
        await showQueue(ctx, backendDb, config);
        return true;
      },
    },
    {
      name: "queue-attention",
      matches: (data) => data === "queue_attention",
      handle: async (ctx) => {
        await ctx.answerCallbackQuery();
        await showQueueAttention(ctx, backendDb, config);
        return true;
      },
    },
    {
      name: "queue-attention-page",
      matches: (data) => data.startsWith("queue_attention_page:"),
      handle: async (ctx) => {
        const value = callbackData(ctx).slice("queue_attention_page:".length);
        const page = value === "noop" ? 0 : Number(value);
        await ctx.answerCallbackQuery();
        if (value !== "noop" && Number.isSafeInteger(page) && page >= 0) await showQueueAttention(ctx, backendDb, config, page);
        return true;
      },
    },
    {
      name: "queue-page",
      matches: (data) => data.startsWith("queue_page:"),
      handle: async (ctx) => {
        const value = callbackData(ctx).slice("queue_page:".length);
        const page = value === "noop" ? 0 : Number(value);
        await ctx.answerCallbackQuery();
        if (value !== "noop" && Number.isSafeInteger(page) && page >= 0) await showQueue(ctx, backendDb, config, page);
        return true;
      },
    },
    {
      name: "notifications",
      matches: (data) => data === "notifications_home",
      handle: async (ctx) => {
        await ctx.answerCallbackQuery();
        const actorId = Number(ctx.from?.id);
        await ctx.reply(notificationsInboxText(backendDb, config, actorId, botLocale(backendDb, actorId)), {
          reply_markup: notificationsMenu,
        });
        return true;
      },
    },
    {
      name: "menu-home",
      matches: (data) => data === "menu_home",
      handle: async (ctx) => {
        clearTelegramAnalyticsDashboard(backendDb, Number(ctx.from?.id));
        await ctx.answerCallbackQuery();
        await showMainMenu(ctx, backendDb, mainMenu, true);
        return true;
      },
    },
    {
      name: "progress",
      matches: (data) => data.startsWith("progress"),
      handle: async (ctx) => handleProgressCallback(ctx, backendDb, config),
    },
    {
      name: "delivery-preview",
      matches: (data) => data.startsWith("delivery_preview_"),
      handle: async (ctx) => handleTelegramDeliveryPreviewCallback(ctx, backendDb, config),
    },
    {
      name: "analytics",
      matches: (data) => data.startsWith("analytics_") || data.startsWith("archive_"),
      handle: async (ctx) => handleAnalyticsCallback(ctx, backendDb, config),
    },
    {
      name: "publication",
      matches: (data) => parsePublicationCallback(data) !== null,
      handle: async (ctx) => handlePublicationCallback(ctx, backendDb, config, mainMenu),
    },
    {
      name: "operations",
      matches: (data) => data.startsWith("deploy_"),
      handle: async (ctx) => handleOperationsCallback(ctx, config),
    },
  ];

  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    const routeData = parseCallbackData(ctx);
    const route = callbackRoutes.find((candidate) => candidate.matches(routeData));
    if (route) await route.handle(ctx);
    else {
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      const data = parseCallbackData(ctx);
      const key = data.split(":", 1)[0] ?? "";
      const stale = key.startsWith("video_") || PUBLICATION_ACTIONS.post.includes(key as (typeof PUBLICATION_ACTIONS.post)[number]);
      await ctx.answerCallbackQuery({ text: t(locale, stale ? "action.card-stale" : "action.unknown") });
      if (stale)
        await ctx.reply(t(locale, "action.card-stale"), {
          reply_markup: new InlineKeyboard().text(t(locale, "menu.work-queue"), "queue_home"),
        });
    }
  });
}

type CallbackRoute = {
  name: string;
  matches: (data: string) => boolean;
  handle: (ctx: Context) => Promise<boolean>;
};

function callbackData(ctx: Context): string {
  return ctx.callbackQuery?.data ?? "";
}

function parseCallbackData(ctx: Context): string {
  return parseSessionCallback(callbackData(ctx)).data;
}

function localizedTextVariants(keys: readonly MessageKey[]): string[] {
  return [...new Set((["en", "ru"] as StudioLocale[]).flatMap((locale) => keys.map((key) => t(locale, key))))].filter(
    (value) => value.length > 0,
  );
}

/** Telegram-side gate: does this chat's user resolve to a Studio actor? The bot
 * asks the resolver rather than reading ADMIN_IDS itself, so the credential
 * mapping stays in one place as other interfaces are added. */
export function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  return actorFromTelegramUser(config, userId) !== null;
}
