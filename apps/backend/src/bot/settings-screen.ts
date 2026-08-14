import fs from "node:fs";
import { Menu, type MenuFlavor } from "@grammyjs/menu";
import type { Bot, Context } from "grammy";
import { importManualAnalytics, manualThreadsFollowers } from "../analytics/import-manual-analytics.js";
import { importXAnalyticsCsv } from "../analytics/import-x-csv.js";
import { listChannels } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { materializeTelegramFile } from "../foundation/external/telegram-files.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { STUDIO_LOCALE_NAMES, STUDIO_LOCALES, type StudioLocale } from "../foundation/locale.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { sendDailyNewsDigest } from "../interfaces/telegram/news-digest.js";
import type { StudioZernioAccount } from "../studio/services/channels.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { mainMenuText, persistentKeyboard } from "./menu-render.js";

export const SETTINGS_MENU_ID = "settings-menu";
const PUBLISHING_MENU_ID = "settings-publishing";
const NOTIFICATIONS_CATEGORY_MENU_ID = "settings-notifications-category";
const ANALYTICS_MENU_ID = "settings-analytics";
const GENERAL_MENU_ID = "settings-general";
const NOTIFICATION_SETTINGS_MENU_ID = "settings-notifications";
const WEEKLY_DIGEST_MENU_ID = "settings-weekly-digest";
const BACKUP_MENU_ID = "settings-backup";
const NEWS_DIGEST_MENU_ID = "settings-news-digest";
const NEWS_DIGEST_TIME_MENU_ID = "settings-news-digest-time";
const YOUTUBE_SIGNATURE_MENU_ID = "settings-youtube";
const LANGUAGE_MENU_ID = "settings-language";
const CHANNELS_MENU_ID = "settings-channels";
const TIMEZONE_MENU_ID = "settings-timezone";
const THREADS_FOLLOWERS_MENU_ID = "settings-threads-followers";
const X_IMPORT_MENU_ID = "settings-x-import";
type ZernioAccount = StudioZernioAccount;
const discoveredAccounts = new Map<number, { locale: "ru" | "en"; accounts: ZernioAccount[] }>();

type SettingsInputStep = "timezone" | "news_digest_prompt" | "news_digest_time" | "threads_followers" | "x_import" | "youtube_signature";

const TIMEZONE_OPTIONS = [
  ["UTC", "UTC"],
  ["Europe/London", "Europe/London"],
  ["Europe/Berlin", "Europe/Berlin"],
  ["Europe/Moscow", "Europe/Moscow"],
  ["Asia/Dubai", "Asia/Dubai"],
  ["Asia/Tashkent", "Asia/Tashkent"],
  ["Asia/Kolkata", "Asia/Kolkata"],
  ["Asia/Bangkok", "Asia/Bangkok"],
  ["Asia/Singapore", "Asia/Singapore"],
  ["Asia/Tokyo", "Asia/Tokyo"],
  ["Australia/Sydney", "Australia/Sydney"],
  ["America/New_York", "America/New_York"],
  ["America/Chicago", "America/Chicago"],
  ["America/Denver", "America/Denver"],
  ["America/Los_Angeles", "America/Los_Angeles"],
] as const;

/** Settings is an interface screen: it owns its callbacks while the shared
 * durable conversation store owns which input the actor is answering. */
export async function handleSettingsMessage(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const actorId = Number(ctx.from?.id);
  const state = getConversationState(backendDb, actorId, "settings");
  if (!state) return false;
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text?.trim() ?? "") : "";
  if (isNavigationMessage(text)) {
    clearConversationState(backendDb, actorId, "settings");
    return false;
  }
  if (state.step === "x_import") return collectXAnalyticsCsv(ctx, backendDb, config, actorId, settingsMenu);
  clearConversationState(backendDb, actorId, "settings");
  if (state.step === "threads_followers")
    return collectThreadsFollowers(ctx, backendDb, actorId, text, settingsMenu, state.data.account === "en" ? "en" : "ru");
  if (state.step === "timezone") return collectTimezone(ctx, backendDb, config, actorId, text, settingsMenu);
  if (state.step === "news_digest_time") return collectNewsDigestTime(ctx, backendDb, config, actorId, text, settingsMenu);
  if (state.step === "news_digest_prompt") return collectNewsDigestPrompt(ctx, backendDb, config, actorId, text, settingsMenu);
  if (state.step !== "youtube_signature") return false;
  createStudioServices(backendDb, config).settings.setYoutubeSignature(actorId, text);
  const locale = settingsService(backendDb).locale(actorId);
  await ctx.reply(t(locale, "settings.youtube-saved"));
  await ctx.reply(youtubeSignatureText(backendDb, config, actorId, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(YOUTUBE_SIGNATURE_MENU_ID),
  });
  return true;
}

function beginSettingsInput(backendDb: BackendDb, actorId: number, step: SettingsInputStep, data: Record<string, unknown> = {}): void {
  saveConversationState(backendDb, actorId, { kind: "settings", draftId: null, step, data, controlMessageId: null });
}

export function buildSettingsMenu(config: BackendConfig, backendDb: BackendDb, bot: Bot | null = null): Menu<Context> {
  const channels = new Menu<Context>(CHANNELS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const studioChannels = createStudioServices(backendDb, config).channels;
    const discovered = discoveredAccounts.get(actorId);
    if (discovered) {
      for (const account of discovered.accounts) {
        if (!account._id) continue;
        const platform = zernioPlatform(account);
        // A channel the pipeline has no target for would sit in the registry
        // and never publish, so it is never offered.
        if (!studioChannels.isPublishablePlatform(platform)) continue;
        range
          .text(
            `${channelPlatformLabel(platform)} ${discovered.locale.toUpperCase()} · @${account.username ?? account.displayName ?? account._id}`,
            async (ctx) => {
              studioChannels.connect({
                platform,
                locale: discovered.locale,
                provider: "zernio",
                ...(account._id ? { providerAccountId: account._id } : {}),
                label: `${channelPlatformLabel(platform)} ${discovered.locale.toUpperCase()} · @${account.username ?? account.displayName ?? account._id}`,
              });
              discoveredAccounts.delete(actorId);
              await ctx.answerCallbackQuery({ text: t(locale, "settings.channel-connected") });
              await ctx.editMessageText(channelsText(backendDb, config, locale));
            },
          )
          .row();
      }
    }
    for (const platform of ["threads", "instagram"] as const) {
      const ru = studioChannels.nativeConnectUrl(platform, "ru");
      const en = studioChannels.nativeConnectUrl(platform, "en");
      if (ru) range.url(t(locale, "settings.connect-native", { platform: channelPlatformLabel(platform), locale: "RU" }), ru);
      if (en) range.url(t(locale, "settings.connect-native", { platform: channelPlatformLabel(platform), locale: "EN" }), en);
      if (ru || en) range.row();
    }
    if (config.ZERNIO_API_KEY)
      range
        .text("➕ Zernio · RU", (ctx) => discoverZernio(ctx, actorId, "ru", locale))
        .text("➕ Zernio · EN", (ctx) => discoverZernio(ctx, actorId, "en", locale))
        .row();
    range.back(t(locale, "settings.back-to-publishing"), async (ctx) => {
      discoveredAccounts.delete(actorId);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "settings.category-publishing-body"));
    });
  });

  const notificationSettings = new Menu<Context>(NOTIFICATION_SETTINGS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const settings = createStudioServices(backendDb, config).settings.notifications(actorId);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .text(`${settings.remindersEnabled ? "✅" : "◻️"} ${t(locale, "settings.reminder-label")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setNotifications(actorId, { remindersEnabled: !settings.remindersEnabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .text(`${settings.completionEnabled ? "✅" : "◻️"} ${t(locale, "settings.completion-label")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setNotifications(actorId, { completionEnabled: !settings.completionEnabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row();
    for (const minutes of [1, 5, 10, 15, 30] as const) {
      range.text(String(minutes), async (ctx) => {
        createStudioServices(backendDb, config).settings.setNotifications(actorId, { reminderMinutes: minutes });
        await ctx.answerCallbackQuery({ text: t(locale, "settings.minutes-toast", { minutes }) });
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      });
    }
    range.row().back(t(locale, "settings.back-to-notifications"), async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "settings.category-notifications-body"));
    });
  });

  const weeklyDigest = new Menu<Context>(WEEKLY_DIGEST_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const settings = createStudioServices(backendDb, config).settings.weeklyDigest();
    const locale = settingsService(backendDb).locale(actorId);
    range
      .text(`${settings.enabled ? "✅" : "◻️"} ${t(locale, "settings.weekly-digest-enabled")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setWeeklyDigest({ enabled: !settings.enabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(weeklyDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row();
    for (const weekday of [1, 2, 3, 4, 5, 6, 0] as const) {
      range.text(`${settings.weekday === weekday ? "● " : ""}${weekdayLabel(locale, weekday)}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setWeeklyDigest({ weekday });
        await ctx.answerCallbackQuery({ text: t(locale, "settings.weekly-digest-day-set", { day: weekdayLabel(locale, weekday) }) });
        await ctx.editMessageText(weeklyDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      });
      if (weekday === 4) range.row();
    }
    range.row().back(t(locale, "settings.back-to-notifications"), async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "settings.category-notifications-body"));
    });
  });

  const backup = new Menu<Context>(BACKUP_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    const settings = createStudioServices(backendDb, config).settings.backup();
    range
      .text(`${settings.enabled ? "✅" : "◻️"} ${t(locale, "settings.backup-enabled")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setBackup({ enabled: !settings.enabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(backupText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row()
      .back(t(locale, "settings.back-to-notifications"), async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-notifications-body"));
      });
  });

  const newsDigestTime = new Menu<Context>(NEWS_DIGEST_TIME_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    const settings = createStudioServices(backendDb, config).settings.newsDigest();
    for (let hour = 0; hour < 24; hour += 1) {
      const label = `${settings.hour === hour && settings.minute === 0 ? "● " : ""}${formatTime(hour, 0)}`;
      range.text(label, async (ctx) => {
        createStudioServices(backendDb, config).settings.setNewsDigest({ hour, minute: 0 });
        await ctx.answerCallbackQuery({ text: t(locale, "settings.news-digest-time-set", { time: formatTime(hour, 0) }) });
        await ctx.editMessageText(newsDigestTimeText(backendDb, config, locale), { parse_mode: "Markdown" });
      });
      if (hour % 4 === 3) range.row();
    }
    range
      .text(t(locale, "settings.news-digest-time-custom"), async (ctx) => {
        beginSettingsInput(backendDb, Number(ctx.from?.id), "news_digest_time");
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.news-digest-time-input-prompt"));
      })
      .row()
      .back(t(locale, "settings.back-to-news-digest"), async (ctx) => {
        clearConversationState(backendDb, Number(ctx.from?.id), "settings");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(newsDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      });
  });

  const newsDigest = new Menu<Context>(NEWS_DIGEST_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const settings = createStudioServices(backendDb, config).settings.newsDigest();
    range
      .text(`${settings.enabled ? "✅" : "◻️"} ${t(locale, "settings.news-digest-enabled")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setNewsDigest({ enabled: !settings.enabled });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(newsDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(
        `${t(locale, "settings.news-digest-time")}: ${formatTime(settings.hour, settings.minute)}`,
        NEWS_DIGEST_TIME_MENU_ID,
        async (ctx) => {
          await ctx.answerCallbackQuery();
          await ctx.editMessageText(newsDigestTimeText(backendDb, config, locale), { parse_mode: "Markdown" });
        },
      )
      .row()
      .text(t(locale, "settings.news-digest-prompt-edit"), async (ctx) => {
        beginSettingsInput(backendDb, actorId, "news_digest_prompt");
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.news-digest-prompt-input"));
      })
      .row()
      .text(t(locale, "settings.news-digest-send-now"), async (ctx) => {
        if (!bot) {
          await ctx.answerCallbackQuery({ text: t(locale, "settings.news-digest-unavailable"), show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery({ text: t(locale, "settings.news-digest-send-started") });
        const result = await sendDailyNewsDigest(config, backendDb, bot, new Date(), { force: true });
        if (result.status === "failed") await ctx.reply(t(locale, "settings.news-digest-send-failed", { error: result.error }));
        else if (result.status === "missing_prompt") await ctx.reply(t(locale, "settings.news-digest-prompt-missing"));
        else if (result.status === "already_sent") await ctx.reply(t(locale, "settings.news-digest-already-sent"));
      })
      .row()
      .back(t(locale, "settings.back-to-notifications"), async (ctx) => {
        clearConversationState(backendDb, actorId, "settings");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-notifications-body"));
      });
  });

  const youtubeSignature = new Menu<Context>(YOUTUBE_SIGNATURE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .text(t(locale, "settings.edit"), async (ctx) => {
        beginSettingsInput(backendDb, actorId, "youtube_signature");
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.youtube-edit-prompt"));
      })
      .text(t(locale, "settings.clear"), async (ctx) => {
        createStudioServices(backendDb, config).settings.clearYoutubeSignature(actorId);
        await ctx.answerCallbackQuery({ text: t(locale, "settings.cleared") });
        await ctx.editMessageText(youtubeSignatureText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row()
      .back(t(locale, "settings.back-to-publishing"), async (ctx) => {
        clearConversationState(backendDb, actorId, "settings");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-publishing-body"));
      });
  });

  const language = new Menu<Context>(LANGUAGE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    for (const target of STUDIO_LOCALES) range.text(STUDIO_LOCALE_NAMES[target], (ctx) => switchLanguage(ctx, target));
    range.row().back(t(locale, "settings.back-to-general"), async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "settings.category-general-body"));
    });
  });

  const timezone = new Menu<Context>(TIMEZONE_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    const service = createStudioServices(backendDb, config).settings;
    const current = service.timezone(actorId, config.TIMEZONE);
    const options = TIMEZONE_OPTIONS.some(([zone]) => zone === current) ? TIMEZONE_OPTIONS : [[current, current], ...TIMEZONE_OPTIONS];
    for (let index = 0; index < options.length; index += 2) {
      for (const [zone, label] of options.slice(index, index + 2))
        range.text(`${zone === current ? "●" : "○"} ${label}`, async (ctx) => {
          service.setTimezone(actorId, zone);
          await ctx.answerCallbackQuery({ text: t(locale, "settings.timezone-set", { timezone: zone }) });
          await ctx.editMessageText(timezoneText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
        });
      if (index + 2 < options.length) range.row();
    }
    range.row().text(t(locale, "settings.timezone-custom"), async (ctx) => {
      beginSettingsInput(backendDb, actorId, "timezone");
      await ctx.answerCallbackQuery();
      await ctx.reply(t(locale, "settings.timezone-input-prompt"));
    });
    range.row().back(t(locale, "settings.back-to-general"), async (ctx) => {
      clearConversationState(backendDb, actorId, "settings");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t(locale, "settings.category-general-body"));
    });
  });

  const threadsFollowers = new Menu<Context>(THREADS_FOLLOWERS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    for (const account of ["ru", "en"] as const)
      range.text(t(locale, "settings.threads-edit", { account: account.toUpperCase() }), async (ctx) => {
        beginSettingsInput(backendDb, actorId, "threads_followers", { account });
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.threads-ask", { account: account.toUpperCase() }));
      });
    range.row().back(t(locale, "settings.back-to-analytics"), async (ctx) => {
      clearConversationState(backendDb, actorId, "settings");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(analyticsText(backendDb, locale), { parse_mode: "Markdown" });
    });
  });

  const xImport = new Menu<Context>(X_IMPORT_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .text(t(locale, "settings.x-import-start"), async (ctx) => {
        beginSettingsInput(backendDb, actorId, "x_import");
        await ctx.answerCallbackQuery();
        await ctx.reply(t(locale, "settings.x-import-ask"));
      })
      .row()
      .back(t(locale, "settings.back-to-analytics"), async (ctx) => {
        clearConversationState(backendDb, actorId, "settings");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(analyticsText(backendDb, locale), { parse_mode: "Markdown" });
      });
  });

  const publishing = new Menu<Context>(PUBLISHING_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .submenu(t(locale, "settings.channels"), CHANNELS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(channelsText(backendDb, config, locale));
      })
      .row();
    if (listChannels(backendDb).some((channel) => channel.platform === "youtube"))
      range
        .submenu(t(locale, "settings.youtube-signature"), YOUTUBE_SIGNATURE_MENU_ID, async (ctx) => {
          await ctx.answerCallbackQuery();
          await ctx.editMessageText(youtubeSignatureText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
        })
        .row();
    range.back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });

  const notificationsCategory = new Menu<Context>(NOTIFICATIONS_CATEGORY_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .submenu(t(locale, "settings.publication-notifications"), NOTIFICATION_SETTINGS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(t(locale, "settings.weekly-digest"), WEEKLY_DIGEST_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(weeklyDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(t(locale, "settings.news-digest"), NEWS_DIGEST_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(newsDigestText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(t(locale, "settings.backup"), BACKUP_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(backupText(backendDb, config, locale), { parse_mode: "Markdown" });
      })
      .row()
      .back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });

  const analytics = new Menu<Context>(ANALYTICS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    range
      .submenu(t(locale, "settings.threads-followers"), THREADS_FOLLOWERS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(threadsFollowersText(backendDb, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(t(locale, "settings.x-import"), X_IMPORT_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.x-import-body"), { parse_mode: "Markdown" });
      })
      .row()
      .back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });

  const general = new Menu<Context>(GENERAL_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .submenu(t(locale, "settings.timezone"), TIMEZONE_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(timezoneText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row()
      .submenu(t(locale, "settings.language"), LANGUAGE_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.language-title"));
      })
      .row()
      .back(t(locale, "settings.back-to-settings"), backToSettings(backendDb));
  });

  // One screen per concern, and the root only names the concerns: the flat list
  // it replaced put an inbox, a digest schedule and a language picker on one
  // keyboard, where every entry had to be read to find any of them.
  const settings = new Menu<Context>(SETTINGS_MENU_ID, { autoAnswer: false });
  settings.dynamic((ctx, range) => {
    const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
    range
      .submenu(t(locale, "settings.category-publishing"), PUBLISHING_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-publishing-body"));
      })
      .row()
      .submenu(t(locale, "settings.category-notifications"), NOTIFICATIONS_CATEGORY_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-notifications-body"));
      })
      .row();
    range
      .submenu(t(locale, "settings.category-analytics"), ANALYTICS_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(analyticsText(backendDb, locale), { parse_mode: "Markdown" });
      })
      .row();
    range
      .submenu(t(locale, "settings.category-general"), GENERAL_MENU_ID, async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(t(locale, "settings.category-general-body"));
      })
      .row()
      .back(t(locale, "common.menu"), async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(mainMenuText(backendDb, config, Number(ctx.from?.id)));
      });
  });
  publishing.register(channels);
  publishing.register(youtubeSignature);
  notificationsCategory.register(notificationSettings);
  notificationsCategory.register(weeklyDigest);
  notificationsCategory.register(backup);
  notificationsCategory.register(newsDigest);
  newsDigest.register(newsDigestTime);
  analytics.register(threadsFollowers);
  analytics.register(xImport);
  general.register(language);
  general.register(timezone);
  settings.register(publishing);
  settings.register(notificationsCategory);
  settings.register(analytics);
  settings.register(general);
  return settings;

  async function discoverZernio(ctx: Context & MenuFlavor, actorId: number, channelLocale: "ru" | "en", locale: StudioLocale) {
    try {
      const studioChannels = createStudioServices(backendDb, config).channels;
      const accounts = await studioChannels.discoverZernioAccounts();
      const supported = accounts.filter((account) => studioChannels.isPublishablePlatform(zernioPlatform(account)));
      discoveredAccounts.set(actorId, { locale: channelLocale, accounts });
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-found", { count: supported.length }) });
      await ctx.editMessageText(channelsText(backendDb, config, locale, supported.length, accounts.length - supported.length));
      await ctx.menu.update();
    } catch {
      await ctx.answerCallbackQuery({ text: t(locale, "settings.channels-error"), show_alert: true });
    }
  }

  async function switchLanguage(ctx: Context & MenuFlavor, locale: StudioLocale): Promise<void> {
    const actorId = Number(ctx.from?.id);
    createStudioServices(backendDb, config).settings.setLocale(actorId, locale);
    await ctx.answerCallbackQuery({ text: t(locale, "settings.language-set") });
    ctx.menu.nav(SETTINGS_MENU_ID);
    await ctx.editMessageText(t(locale, "settings.title"));
    await ctx.reply(t(locale, "settings.keyboard-updated"), { reply_markup: persistentKeyboard(locale) });
  }
}

/** Every category returns to the same root screen, and a `.back()` that leaves
 * the previous screen's body text on the message reads as a failed tap. */
function backToSettings(backendDb: BackendDb) {
  return async (ctx: Context): Promise<void> => {
    clearConversationState(backendDb, Number(ctx.from?.id), "settings");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t(settingsService(backendDb).locale(Number(ctx.from?.id)), "settings.title"));
  };
}

function analyticsText(backendDb: BackendDb, locale: StudioLocale): string {
  const followers = manualThreadsFollowers(backendDb);
  const value = (count: number | null) => (count == null ? t(locale, "settings.threads-unknown") : String(count));
  return t(locale, "settings.category-analytics-body", { ru: value(followers.ru), en: value(followers.en) });
}

function threadsFollowersText(backendDb: BackendDb, locale: StudioLocale): string {
  const followers = manualThreadsFollowers(backendDb);
  const value = (count: number | null) => (count == null ? t(locale, "settings.threads-unknown") : String(count));
  return t(locale, "settings.threads-body", {
    ru: value(followers.ru),
    en: value(followers.en),
    updated: followers.updatedAt?.slice(0, 16).replace("T", " ") ?? t(locale, "settings.threads-unknown"),
  });
}

/**
 * Stores one hand-counted Threads audience number.
 *
 * Threads has no API here, so this screen is the only place the number can come
 * from, and the moment it is typed is the sample's timestamp.
 */
async function collectThreadsFollowers(
  ctx: Context,
  backendDb: BackendDb,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
  account: "ru" | "en",
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const count = Number(text.replace(/[\s,]/gu, ""));
  if (!Number.isSafeInteger(count) || count < 0) {
    await ctx.reply(t(locale, "err.threads-followers-invalid"));
    return true;
  }
  importManualAnalytics(backendDb, {
    sampledAt: messageSampledAt(ctx),
    ...(account === "ru" ? { threadsRuFollowers: count } : { threadsEnFollowers: count }),
  });
  await ctx.reply(t(locale, "settings.threads-saved", { account: account.toUpperCase(), count }));
  await ctx.reply(threadsFollowersText(backendDb, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(THREADS_FOLLOWERS_MENU_ID),
  });
  return true;
}

/**
 * Imports an X Analytics export that arrived as a Telegram document.
 *
 * The export carries no timestamp of its own, so the message's own time stands
 * in for it — handing the file over is the closest observable moment to taking
 * it. Re-sending the same file is a no-op by checksum, which is why this can
 * stay a single button.
 */
async function collectXAnalyticsCsv(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  if (!document) {
    await ctx.reply(t(locale, "settings.x-import-expects-file"));
    return true;
  }
  clearConversationState(backendDb, actorId, "settings");
  if (!/\.csv$/iu.test(document.file_name ?? "")) {
    await ctx.reply(t(locale, "settings.x-import-expects-file"));
    return true;
  }
  const apiFile = await ctx.api.getFile(document.file_id);
  if (!apiFile.file_path) {
    await ctx.reply(t(locale, "settings.x-import-failed", { error: "no file path" }));
    return true;
  }
  const downloaded = await materializeTelegramFile(config, { filePath: apiFile.file_path }, { extension: ".csv" });
  try {
    const result = importXAnalyticsCsv(backendDb, downloaded.path, messageSampledAt(ctx), document.file_name ?? undefined);
    await ctx.reply(
      result.duplicateImport
        ? t(locale, "settings.x-import-duplicate")
        : t(locale, "settings.x-import-done", {
            rows: result.rows,
            items: result.activityItems,
            linked: result.linkedByExternalId + result.linkedByText,
            samples: result.insertedSamples,
          }),
      { parse_mode: "Markdown", reply_markup: settingsMenu.at(X_IMPORT_MENU_ID) },
    );
  } catch (error) {
    await ctx.reply(t(locale, "settings.x-import-failed", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    if (downloaded.temporary) await fs.promises.rm(downloaded.path, { force: true });
  }
  return true;
}

/** The message is the observation: both manual imports are stamped with when
 * the operator handed the numbers over, never with when the row was written. */
function messageSampledAt(ctx: Context): string {
  const seconds = ctx.message?.date;
  return new Date(seconds ? seconds * 1000 : Date.now()).toISOString();
}

function weekdayLabel(locale: StudioLocale, weekday: number): string {
  const labels = locale === "ru" ? ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return labels[weekday] ?? labels[0] ?? "";
}

function weeklyDigestText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const settings = createStudioServices(backendDb, config).settings.weeklyDigest();
  return t(locale, "settings.weekly-digest-body", {
    status: settings.enabled ? t(locale, "settings.on") : t(locale, "settings.off"),
    day: weekdayLabel(locale, settings.weekday),
  });
}

function backupText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  return t(locale, "settings.backup-body", {
    status: createStudioServices(backendDb, config).settings.backup().enabled ? t(locale, "settings.on") : t(locale, "settings.off"),
  });
}

function newsDigestText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const settings = createStudioServices(backendDb, config).settings.newsDigest();
  return t(locale, "settings.news-digest-body", {
    status: settings.enabled ? t(locale, "settings.on") : t(locale, "settings.off"),
    time: formatTime(settings.hour, settings.minute),
    timezone: config.TIMEZONE_LABEL,
    prompt: settings.prompt ? t(locale, "settings.news-digest-prompt-set") : t(locale, "settings.news-digest-prompt-missing"),
  });
}

function newsDigestTimeText(backendDb: BackendDb, config: BackendConfig, locale: StudioLocale): string {
  const settings = createStudioServices(backendDb, config).settings.newsDigest();
  return t(locale, "settings.news-digest-time-body", {
    time: formatTime(settings.hour, settings.minute),
    timezone: config.TIMEZONE_LABEL,
  });
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

async function collectNewsDigestPrompt(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  try {
    createStudioServices(backendDb, config).settings.setNewsDigest({ prompt: text === "-" ? "" : text });
    await ctx.reply(t(locale, "settings.news-digest-prompt-saved"));
    await ctx.reply(newsDigestText(backendDb, config, locale), {
      parse_mode: "Markdown",
      reply_markup: settingsMenu.at(NEWS_DIGEST_MENU_ID),
    });
  } catch (error) {
    await ctx.reply(describeError(locale, error));
  }
  return true;
}

async function collectNewsDigestTime(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  const match = /^(\d{1,2}):(\d{2})$/u.exec(text);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    await ctx.reply(t(locale, "err.news-digest-time-invalid"));
    return true;
  }
  createStudioServices(backendDb, config).settings.setNewsDigest({ hour, minute });
  await ctx.reply(t(locale, "settings.news-digest-time-set", { time: formatTime(hour, minute) }));
  await ctx.reply(newsDigestTimeText(backendDb, config, locale), {
    parse_mode: "Markdown",
    reply_markup: settingsMenu.at(NEWS_DIGEST_TIME_MENU_ID),
  });
  return true;
}

/**
 * A message that is navigation rather than input.
 *
 * Settings input sits in front of the router and claims the next message.
 * Commands and persistent keyboard navigation must leave that input instead.
 */
function isNavigationMessage(text: string): boolean {
  return text.startsWith("/") || text === t("en", "menu.button") || text === t("ru", "menu.button");
}

async function collectTimezone(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  text: string,
  settingsMenu: Menu<Context>,
): Promise<boolean> {
  const locale = settingsService(backendDb).locale(actorId);
  try {
    createStudioServices(backendDb, config).settings.setTimezone(actorId, text);
    await ctx.reply(t(locale, "settings.timezone-set", { timezone: text }));
    await ctx.reply(timezoneText(backendDb, config, actorId, locale), {
      parse_mode: "Markdown",
      reply_markup: settingsMenu.at(TIMEZONE_MENU_ID),
    });
  } catch {
    await ctx.reply(t(locale, "err.timezone-invalid"));
  }
  return true;
}

function zernioPlatform(account: ZernioAccount): string {
  const value = account.platform?.trim().toLowerCase() ?? "";
  if (value.includes("tiktok")) return "tiktok";
  if (value.includes("youtube")) return "youtube";
  if (value.includes("instagram")) return "instagram";
  // Anything else is passed through unchanged so the publishable-platform
  // filter drops it, instead of a new platform silently posing as Instagram.
  return value;
}

function channelPlatformLabel(platform: string): string {
  if (platform === "tiktok") return "TikTok";
  if (platform === "youtube") return "YouTube";
  if (platform === "threads") return "Threads";
  return "Instagram";
}

function channelsText(
  backendDb: BackendDb,
  config: BackendConfig,
  locale: StudioLocale,
  discoveredCount?: number,
  hiddenCount = 0,
): string {
  const rows = createStudioServices(backendDb, config)
    .channels.list()
    .map((channel) => `• ${channel.label} — ${channel.provider}${channel.providerAccountId ? ` · ${channel.providerAccountId}` : ""}`);
  const suffix = discoveredCount == null ? "" : `\n\n${t(locale, "settings.channels-pick", { count: discoveredCount })}`;
  const hidden = hiddenCount ? `\n${t(locale, "settings.channels-unsupported", { count: hiddenCount })}` : "";
  return `${t(locale, "settings.channels-title")}\n\n${rows.join("\n") || t(locale, "settings.channels-none")}${suffix}${hidden}`;
}

export async function showSettings(ctx: Context, backendDb: BackendDb, settingsMenu: Menu<Context>, edit = false): Promise<void> {
  const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
  const text = t(locale, "settings.title");
  const options = { reply_markup: settingsMenu };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

function notificationSettingsText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: StudioLocale): string {
  const settings = createStudioServices(backendDb, config).settings.notifications(actorId);
  const on = (value: boolean) => (value ? t(locale, "settings.on") : t(locale, "settings.off"));
  return t(locale, "settings.notif-body", {
    reminders: on(settings.remindersEnabled),
    minutes: settings.reminderMinutes,
    completion: on(settings.completionEnabled),
  });
}

function timezoneText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: StudioLocale): string {
  const current = createStudioServices(backendDb, config).settings.timezone(actorId, config.TIMEZONE);
  return t(locale, "settings.timezone-body", { timezone: current });
}

function youtubeSignatureText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: StudioLocale): string {
  const signature = createStudioServices(backendDb, config).settings.youtubeSignature(actorId);
  return t(locale, "settings.youtube-body", {
    signature: signature ? escapeMarkdown(signature) : t(locale, "settings.youtube-not-set"),
  });
}
