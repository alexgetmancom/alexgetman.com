import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import {
  clearTelegramAnalyticsDashboard,
  setTelegramAnalyticsDashboard,
  telegramAnalyticsDashboards,
} from "../interfaces/telegram/control-cards.js";
import { sendTelegramArchiveMedia } from "../interfaces/telegram/delivery-previews.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";

/** Telegram adapter for the Analytics Studio screen. The analytics read model itself stays transport-neutral. */
export async function handleAnalyticsCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  const analytics = studioServices(backendDb, config).analytics;
  if (data === "archive_noop") {
    await ctx.answerCallbackQuery();
    return true;
  }
  if (data === "analytics_home") {
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, defaultAnalyticsSection(config), 1);
    return true;
  }
  if (data === "archive_home") {
    clearTelegramAnalyticsDashboard(backendDb, actorId);
    const summary = analytics.archiveSummary(locale);
    const keyboard = new InlineKeyboard().text(t(locale, "analytics.posts-btn", { count: summary.posts }), "analytics_post_archive:0");
    if (config.studio.modules.video_posting)
      keyboard.row().text(t(locale, "analytics.videos-btn", { count: summary.videos }), "analytics_archive:0");
    keyboard.row().text(t(locale, "common.menu"), "menu_home");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(summary.text, { parse_mode: "Markdown", reply_markup: keyboard });
    return true;
  }
  if (data === "analytics_total" || data.startsWith("analytics_period:")) {
    const days = data.startsWith("analytics_period:") ? Number(data.slice("analytics_period:".length)) : 7;
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, defaultAnalyticsSection(config), analyticsPeriod(days));
    return true;
  }
  if (data.startsWith("analytics_section:")) {
    const [, sectionValue, daysValue] = data.split(":");
    const requested: AnalyticsSection =
      sectionValue === "audience" || sectionValue === "posts" || sectionValue === "video" ? sectionValue : "overview";
    const section = requested === "overview" && !showOverview(config) ? defaultAnalyticsSection(config) : requested;
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, section, analyticsPeriod(Number(daysValue)));
    return true;
  }
  if (data.startsWith("analytics_archive:")) {
    const offset = Math.max(0, Number(data.slice("analytics_archive:".length)) || 0);
    const archive = analytics.videoArchive(offset, locale);
    const keyboard = new InlineKeyboard();
    for (const item of archive.items) keyboard.text(item.label, `analytics_video:${item.id}`).row();
    archivePagination(keyboard, locale, "analytics_archive", offset, archive.items.length, archive.total);
    keyboard.text(t(locale, "analytics.back-archive"), "archive_home").row().text(t(locale, "common.menu"), "menu_home");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(archive.text, { reply_markup: keyboard });
    return true;
  }
  if (data.startsWith("analytics_video:")) {
    const id = archiveItemId(data, "analytics_video:");
    await ctx.answerCallbackQuery();
    if (id == null) return true;
    await ctx.editMessageText(analytics.videoMetrics(id, locale), {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text(t(locale, "analytics.back-archive"), "analytics_archive:0")
        .row()
        .text(t(locale, "common.menu"), "menu_home"),
    });
    return true;
  }
  if (data.startsWith("analytics_post_archive:")) {
    const offset = Math.max(0, Number(data.slice("analytics_post_archive:".length)) || 0);
    const archive = analytics.postArchive(offset, locale);
    const keyboard = new InlineKeyboard();
    for (const item of archive.items) keyboard.text(item.label, `analytics_post:${item.id}`).row();
    archivePagination(keyboard, locale, "analytics_post_archive", offset, archive.items.length, archive.total);
    keyboard.text(t(locale, "analytics.back-archive"), "archive_home").row().text(t(locale, "common.menu"), "menu_home");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(archive.text, { reply_markup: keyboard });
    return true;
  }
  if (data.startsWith("analytics_post:")) {
    const id = archiveItemId(data, "analytics_post:");
    await ctx.answerCallbackQuery();
    if (id == null) return true;
    const media = analytics.postMedia(id, locale);
    const keyboard = new InlineKeyboard();
    if (media.length) keyboard.text(t(locale, "analytics.show-media"), `analytics_post_media:${id}`).row();
    keyboard.text(t(locale, "analytics.back-archive"), "analytics_post_archive:0").row().text(t(locale, "common.menu"), "menu_home");
    await ctx.editMessageText(analytics.postMetrics(id, locale), {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    return true;
  }
  if (data.startsWith("analytics_post_media:")) {
    const id = archiveItemId(data, "analytics_post_media:");
    await ctx.answerCallbackQuery();
    if (id != null) await sendTelegramArchiveMedia(ctx, analytics.postMedia(id, locale));
    return true;
  }
  if (data !== "analytics_ai") return false;
  clearTelegramAnalyticsDashboard(backendDb, actorId);
  await ctx.answerCallbackQuery({ text: t(locale, "analytics.preparing-report") });
  const report = await analytics.audienceAnalysis(locale);
  await ctx.editMessageText(report, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text(t(locale, "analytics.back-video"), "analytics_section:video:7"),
  });
  return true;
}

/** Callback data is attacker-controlled text; an archive id is only usable once
 * it is a real integer. */
function archiveItemId(data: string, prefix: string): number | null {
  const id = Number(data.slice(prefix.length));
  return Number.isSafeInteger(id) ? id : null;
}

function analyticsPeriod(value: number): 1 | 7 | 30 {
  return value === 1 || value === 30 ? value : 7;
}

export async function showAnalyticsDashboard(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  section: AnalyticsSection,
  days: 1 | 7 | 30,
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  const dashboard = studioServices(backendDb, config).analytics.dashboard(section, days, locale);
  const keyboard = analyticsKeyboard(config, locale, section, days);
  await ctx.editMessageText({ html: dashboard.richHtml }, { reply_markup: keyboard });
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (section !== "audience" && Number.isSafeInteger(actorId) && messageId && ctx.chat?.id)
    setTelegramAnalyticsDashboard(backendDb, actorId, Number(ctx.chat.id), messageId, section, days);
}

/** Refreshes only the currently open dashboard for each owner. The interface
 * binding prevents hourly analytics collection from creating chat noise. */
export async function refreshTelegramAnalyticsDashboards(bot: Bot, backendDb: BackendDb, config: BackendConfig): Promise<number> {
  const analytics = studioServices(backendDb, config).analytics;
  const results = await Promise.all(
    telegramAnalyticsDashboards(backendDb).map(async (card) => {
      const section = card.section === "overview" && !showOverview(config) ? defaultAnalyticsSection(config) : card.section;
      const locale = botLocale(backendDb, card.actorId);
      const dashboard = analytics.dashboard(section, card.days, locale);
      try {
        await bot.api.editMessageText(
          card.chatId,
          card.messageId,
          { html: dashboard.richHtml },
          {
            reply_markup: analyticsKeyboard(config, locale, section, card.days),
          },
        );
        return true;
      } catch (error) {
        // The screen may have been superseded or deleted. It is harmless: the
        // next explicit Analytics click records a new binding.
        if (!String(error).includes("message is not modified")) console.warn("Analytics dashboard refresh failed:", error);
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

function analyticsKeyboard(
  config: BackendConfig,
  locale: ReturnType<typeof botLocale>,
  section: AnalyticsSection,
  days: 1 | 7 | 30,
): InlineKeyboard {
  const callback = (nextDays: 1 | 7 | 30) => `analytics_section:${section}:${nextDays}`;
  const keyboard = new InlineKeyboard();
  keyboard
    .text(periodButtonLabel(locale, 1, days), callback(1))
    .text(periodButtonLabel(locale, 7, days), callback(7))
    .text(periodButtonLabel(locale, 30, days), callback(30))
    .row();
  if (showOverview(config))
    keyboard.text(
      t(locale, section === "overview" ? "analytics.overview-active" : "analytics.overview"),
      `analytics_section:overview:${days}`,
    );
  if (config.studio.modules.text_posting)
    keyboard.text(
      t(locale, section === "posts" ? "analytics.posts-section-active" : "analytics.posts-section"),
      `analytics_section:posts:${days}`,
    );
  if (config.studio.modules.video_posting)
    keyboard.text(
      t(locale, section === "video" ? "analytics.video-section-active" : "analytics.video-section"),
      `analytics_section:video:${days}`,
    );
  keyboard.row().text(t(locale, "common.menu"), "menu_home");
  return keyboard;
}

export function defaultAnalyticsSection(config: BackendConfig): AnalyticsSection {
  const preferred = config.studio.analytics.defaultTab;
  if (preferred === "posts" && config.studio.modules.text_posting) return preferred;
  if (preferred === "video" && config.studio.modules.video_posting) return preferred;
  return "overview";
}

function showOverview(config: BackendConfig): boolean {
  return config.studio.modules.text_posting && config.studio.modules.video_posting;
}

const PERIOD_LABELS: Record<1 | 7 | 30, { ru: string; en: string }> = {
  1: { ru: "24 ч", en: "24 h" },
  7: { ru: "7 д", en: "7 d" },
  30: { ru: "30 д", en: "30 d" },
};

function periodButtonLabel(locale: ReturnType<typeof botLocale>, period: 1 | 7 | 30, selected: 1 | 7 | 30): string {
  return `${period === selected ? "• " : ""}${PERIOD_LABELS[period][locale === "ru" ? "ru" : "en"]}`;
}

function archivePagination(
  keyboard: InlineKeyboard,
  locale: ReturnType<typeof botLocale>,
  prefix: "analytics_archive" | "analytics_post_archive",
  offset: number,
  count: number,
  total: number,
): void {
  if (!total) return;
  const page = Math.floor(offset / 10) + 1;
  const pages = Math.max(1, Math.ceil(total / 10));
  if (offset > 0) keyboard.text(t(locale, "analytics.prev"), `${prefix}:${Math.max(0, offset - 10)}`);
  keyboard.text(`${page}/${pages}`, "archive_noop");
  if (offset + count < total) keyboard.text(t(locale, "analytics.next"), `${prefix}:${offset + count}`);
  keyboard.row();
}
