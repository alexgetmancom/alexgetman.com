import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, type Context } from "grammy";
import { handleAnalyticsCallback } from "./bot/analytics-screen.js";
import { runCallbackBoundary } from "./bot/callback-boundary.js";
import { handlePublicationCallback, handlePublicationMessage } from "./bot/callback-router.js";
import { executePublicationEffects } from "./bot/effects.js";
import {
  applyIntakeKind,
  applyIntakeVideoLocale,
  cancelIntake,
  handleIntakeMessage,
  INTAKE_CANCEL,
  INTAKE_KIND_PREFIX,
  INTAKE_LOCALE_PREFIX,
  openIntake,
  publishReviewedArticle,
} from "./bot/intake.js";
import { persistentKeyboard, showMainMenu } from "./bot/menu-render.js";
import { buildMainMenu } from "./bot/navigation.js";
import { handleOperationsCallback } from "./bot/operations-screen.js";
import { handleProgressCallback } from "./bot/progress-screen.js";
import { parseSessionCallback } from "./bot/publication-callback.js";
import { showQueue, showQueueAttention } from "./bot/queue.js";
import { buildSettingsMenu, handleSettingsMessage, showSettings } from "./bot/settings-screen.js";
import type { BackendDb } from "./db/client.js";
import { actorFromTelegramUser } from "./foundation/actors.js";
import type { BackendConfig } from "./foundation/config.js";
import { type MessageKey, t } from "./foundation/i18n/index.js";
import type { StudioLocale } from "./foundation/locale.js";
import { log } from "./foundation/logger.js";
import { clearTelegramAnalyticsDashboard } from "./interfaces/telegram/control-cards.js";
import { handleTelegramDeliveryPreviewCallback } from "./interfaces/telegram/delivery-previews.js";
import { trackUsageAsync } from "./observability/usage.js";
import { settingsService } from "./studio/services/settings.js";

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
  const settingsMenu = buildSettingsMenu(config, backendDb, bot);
  const mainMenu = buildMainMenu(config, backendDb, settingsMenu);
  bot.use(async (ctx, next) => {
    const startedAt = Date.now();
    const updateType = Object.keys(ctx.update).find((key) => key !== "update_id") ?? "unknown";
    let success = false;
    let failure: unknown;
    try {
      await trackUsageAsync(backendDb, "telegram.update.handle", next);
      success = true;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      log(success ? "info" : "warn", "operation timing", {
        operation: "telegram.update.handle",
        updateId: ctx.update.update_id,
        updateType,
        success,
        totalMs: Date.now() - startedAt,
        ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
      });
    }
  });
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
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    if (!isAdmin(config, ctx.from?.id)) return;
    await ctx.reply(t(locale, "start.menu-hint"), {
      reply_markup: persistentKeyboard(locale),
    });
    await showMainMenu(ctx, backendDb, config, mainMenu);
  };
  bot.command("start", showBotMenu);
  bot.hears(localizedTextVariants(["menu.button"]), async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await showMainMenu(ctx, backendDb, config, mainMenu);
  });
  bot.hears("⚙️", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await showSettings(ctx, backendDb, settingsMenu);
  });
  bot.hears(localizedTextVariants(["menu.new-material"]), async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    await openIntake(ctx, backendDb);
  });
  bot.on("message", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    if (await handleSettingsMessage(ctx, backendDb, config, settingsMenu)) return;
    // The intake owns the first message only while it is still deciding what
    // that message is; anything it declines falls through unchanged.
    const intake = await handleIntakeMessage(ctx, backendDb, config);
    if (intake.effects.length) await executePublicationEffects(ctx, backendDb, intake.effects);
    if (intake.handled) return;
    await handlePublicationMessage(ctx, backendDb, config);
  });

  const callbackRoutes: CallbackRoute[] = [
    {
      name: "intake-kind",
      matches: (data) => data.startsWith(INTAKE_KIND_PREFIX),
      handle: async (ctx) => {
        const choice = callbackData(ctx).slice(INTAKE_KIND_PREFIX.length);
        await ctx.answerCallbackQuery();
        if (choice === "article_confirm") {
          const actorId = Number(ctx.from?.id);
          const locale = settingsService(backendDb).locale(actorId);
          const { title } = publishReviewedArticle(backendDb, config, actorId);
          await ctx.reply(t(locale, "intake.article-published", { title }));
          return true;
        }
        if (choice !== "post" && choice !== "article" && choice !== "video") return true;
        await executePublicationEffects(ctx, backendDb, await applyIntakeKind(ctx, backendDb, config, choice));
        return true;
      },
    },
    {
      name: "intake-video-locale",
      matches: (data) => data.startsWith(INTAKE_LOCALE_PREFIX),
      handle: async (ctx) => {
        const choice = callbackData(ctx).slice(INTAKE_LOCALE_PREFIX.length);
        await ctx.answerCallbackQuery();
        if (choice !== "ru" && choice !== "en") return true;
        const effects = await applyIntakeVideoLocale(backendDb, config, Number(ctx.from?.id), choice);
        await executePublicationEffects(ctx, backendDb, effects);
        return true;
      },
    },
    {
      name: "intake-cancel",
      matches: (data) => data === INTAKE_CANCEL,
      handle: async (ctx) => {
        cancelIntake(backendDb, Number(ctx.from?.id));
        await ctx.answerCallbackQuery();
        await showMainMenu(ctx, backendDb, config, mainMenu, true);
        return true;
      },
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
      name: "menu-home",
      matches: (data) => data === "menu_home",
      handle: async (ctx) => {
        clearTelegramAnalyticsDashboard(backendDb, Number(ctx.from?.id));
        await ctx.answerCallbackQuery();
        await showMainMenu(ctx, backendDb, config, mainMenu, true);
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
      matches: (data) => parseSessionCallback(data).callback !== null,
      handle: async (ctx) => handlePublicationCallback(ctx, backendDb, config, mainMenu),
    },
    {
      name: "operations",
      matches: (data) => data.startsWith("deploy_"),
      handle: async (ctx) => handleOperationsCallback(ctx, backendDb, config),
    },
  ];

  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) return;
    const routeData = parseCallbackData(ctx);
    const route = callbackRoutes.find((candidate) => candidate.matches(routeData));
    if (route) await route.handle(ctx);
    else {
      const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
      await ctx.answerCallbackQuery({ text: t(locale, "action.unknown") });
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
 * asks the resolver rather than reading CONTROLLER_ADMIN_IDS itself, so the credential
 * mapping stays in one place as other interfaces are added. */
export function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  return actorFromTelegramUser(config, userId) !== null;
}
