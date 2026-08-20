import { Menu } from "@grammyjs/menu";
import type { Bot, Context } from "grammy";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { describeError, t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { sendDailyNewsDigest } from "../../interfaces/telegram/news-digest.js";
import { createStudioServices } from "../../studio/services/index.js";
import { settingsService } from "../../studio/services/settings.js";
import { clearConversationState } from "../conversation-state.js";
import {
  BACKUP_MENU_ID,
  backToSettings,
  beginSettingsInput,
  formatTime,
  NEWS_DIGEST_MENU_ID,
  NEWS_DIGEST_TIME_MENU_ID,
  NOTIFICATION_SETTINGS_MENU_ID,
  NOTIFICATIONS_MENU_ID,
  WEEKLY_DIGEST_MENU_ID,
  weekdayLabel,
} from "./shared.js";

export function buildNotificationsMenu(config: BackendConfig, backendDb: BackendDb, bot: Bot | null): Menu<Context> {
  const notificationSettings = new Menu<Context>(NOTIFICATION_SETTINGS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const settings = createStudioServices(backendDb, config).settings.notifications(actorId);
    const locale = settingsService(backendDb).locale(actorId);
    range
      .text(`${settings.videoRemindersEnabled ? "✅" : "◻️"} ${t(locale, "settings.video-reminder-label")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setNotifications(actorId, {
          videoRemindersEnabled: !settings.videoRemindersEnabled,
        });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .text(`${settings.postRemindersEnabled ? "✅" : "◻️"} ${t(locale, "settings.post-reminder-label")}`, async (ctx) => {
        createStudioServices(backendDb, config).settings.setNotifications(actorId, {
          postRemindersEnabled: !settings.postRemindersEnabled,
        });
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(notificationSettingsText(backendDb, config, actorId, locale), { parse_mode: "Markdown" });
      })
      .row()
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

  const notifications = new Menu<Context>(NOTIFICATIONS_MENU_ID, { autoAnswer: false }).dynamic((ctx, range) => {
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
  notifications.register(notificationSettings);
  notifications.register(weeklyDigest);
  notifications.register(backup);
  notifications.register(newsDigest);
  newsDigest.register(newsDigestTime);
  return notifications;
}

export async function collectNewsDigestPrompt(
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

export async function collectNewsDigestTime(
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

function notificationSettingsText(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: StudioLocale): string {
  const settings = createStudioServices(backendDb, config).settings.notifications(actorId);
  const on = (value: boolean) => (value ? t(locale, "settings.on") : t(locale, "settings.off"));
  return t(locale, "settings.notif-body", {
    videoReminders: on(settings.videoRemindersEnabled),
    postReminders: on(settings.postRemindersEnabled),
    minutes: settings.reminderMinutes,
    completion: on(settings.completionEnabled),
  });
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
