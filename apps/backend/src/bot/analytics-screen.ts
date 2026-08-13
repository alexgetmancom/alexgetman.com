import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { log } from "../foundation/logger.js";
import {
  clearTelegramAnalyticsDashboard,
  setTelegramAnalyticsDashboard,
  telegramAnalyticsDashboards,
} from "../interfaces/telegram/control-cards.js";
import { sendTelegramArchiveMedia } from "../interfaces/telegram/delivery-previews.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { isUnchangedMessageEdit } from "./telegram-errors.js";

/** The sections this screen offers. The analytics read model also renders an
 * "audience" section, which only MCP asks for — no button here produces it. */
type AnalyticsSection = "overview" | "posts" | "video";

/** Telegram adapter for the Analytics Studio screen. The analytics read model itself stays transport-neutral. */
export async function handleAnalyticsCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const analytics = createStudioServices(backendDb, config).analytics;
  if (data === "archive_noop") {
    await ctx.answerCallbackQuery();
    return true;
  }
  if (data === "analytics_home") {
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, "overview", 1);
    return true;
  }
  if (data === "archive_home") {
    clearTelegramAnalyticsDashboard(backendDb, actorId);
    const summary = analytics.archiveSummary(locale);
    const keyboard = new InlineKeyboard().text(t(locale, "analytics.posts-btn", { count: summary.posts }), "analytics_post_archive:0");
    keyboard.row().text(t(locale, "analytics.videos-btn", { count: summary.videos }), "analytics_archive:0");
    keyboard.row().text(t(locale, "common.menu"), "menu_home");
    await ctx.answerCallbackQuery();
    await editScreen(ctx, summary.text, { parse_mode: "Markdown", reply_markup: keyboard });
    return true;
  }
  if (data === "analytics_total" || data.startsWith("analytics_period:")) {
    const days = data.startsWith("analytics_period:") ? Number(data.slice("analytics_period:".length)) : 7;
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, "overview", analyticsPeriod(days));
    return true;
  }
  if (data.startsWith("analytics_section:")) {
    const [, sectionValue, daysValue] = data.split(":");
    const requested: AnalyticsSection = sectionValue === "posts" || sectionValue === "video" ? sectionValue : "overview";
    const section = requested;
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, section, analyticsPeriod(Number(daysValue)));
    return true;
  }
  if (data.startsWith("analytics_archive:")) {
    const offset = Math.max(0, Number(data.slice("analytics_archive:".length)) || 0);
    const archive = analytics.videoArchive(offset, locale);
    const keyboard = new InlineKeyboard();
    for (const item of archive.items) keyboard.text(item.label, `analytics_video:${item.id}`).row();
    archivePagination(keyboard, locale, "analytics_archive", offset, archive);
    keyboard.text(t(locale, "analytics.back-archive"), "archive_home").row().text(t(locale, "common.menu"), "menu_home");
    await ctx.answerCallbackQuery();
    await editScreen(ctx, archive.text, { reply_markup: keyboard });
    return true;
  }
  if (data.startsWith("analytics_video:")) {
    const id = archiveItemId(data, "analytics_video:");
    await ctx.answerCallbackQuery();
    if (id == null) return true;
    await editScreen(ctx, analytics.videoMetrics(id, locale), {
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
    archivePagination(keyboard, locale, "analytics_post_archive", offset, archive);
    keyboard.text(t(locale, "analytics.back-archive"), "archive_home").row().text(t(locale, "common.menu"), "menu_home");
    await ctx.answerCallbackQuery();
    await editScreen(ctx, archive.text, { reply_markup: keyboard });
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
    await editScreen(ctx, analytics.postMetrics(id, locale), {
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
  return false;
}

/** Telegram rejects an edit whose text and markup match what the message
 * already shows, and every screen here carries a button that re-renders its own
 * state: the active period, the active section, "← Archive" while page 0 is
 * open. A repeat tap is a no-op, not an error. */
async function editScreen(ctx: Context, ...args: Parameters<Context["editMessageText"]>): Promise<void> {
  try {
    await ctx.editMessageText(...args);
  } catch (error) {
    if (!isUnchangedMessageEdit(error)) throw error;
  }
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
  const locale = settingsService(backendDb).locale(actorId);
  const dashboard = createStudioServices(backendDb, config).analytics.dashboard(section, days, locale);
  const keyboard = analyticsKeyboard(locale, section, days);
  await editScreen(ctx, { html: dashboard.richHtml }, { reply_markup: keyboard });
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (Number.isSafeInteger(actorId) && messageId && ctx.chat?.id)
    setTelegramAnalyticsDashboard(backendDb, actorId, Number(ctx.chat.id), messageId, section, days);
}

/** Refreshes only the currently open dashboard for each owner. The interface
 * binding prevents hourly analytics collection from creating chat noise. */
export async function refreshTelegramAnalyticsDashboards(bot: Bot, backendDb: BackendDb, config: BackendConfig): Promise<number> {
  const analytics = createStudioServices(backendDb, config).analytics;
  const results = await Promise.all(
    telegramAnalyticsDashboards(backendDb).map(async (card) => {
      const section = card.section;
      const locale = settingsService(backendDb).locale(card.actorId);
      const dashboard = analytics.dashboard(section, card.days, locale);
      try {
        await bot.api.editMessageText(
          card.chatId,
          card.messageId,
          { html: dashboard.richHtml },
          {
            reply_markup: analyticsKeyboard(locale, section, card.days),
          },
        );
        return true;
      } catch (error) {
        // The screen may have been superseded or deleted. It is harmless: the
        // next explicit Analytics click records a new binding.
        if (!isUnchangedMessageEdit(error)) log("warn", "analytics dashboard refresh failed", { actorId: card.actorId, section, error });
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

function analyticsKeyboard(locale: StudioLocale, section: AnalyticsSection, days: 1 | 7 | 30): InlineKeyboard {
  const callback = (nextDays: 1 | 7 | 30) => `analytics_section:${section}:${nextDays}`;
  const keyboard = new InlineKeyboard();
  keyboard
    .text(periodButtonLabel(locale, 1, days), callback(1))
    .text(periodButtonLabel(locale, 7, days), callback(7))
    .text(periodButtonLabel(locale, 30, days), callback(30))
    .row();
  keyboard.text(
    t(locale, section === "overview" ? "analytics.overview-active" : "analytics.overview"),
    `analytics_section:overview:${days}`,
  );
  keyboard.text(
    t(locale, section === "posts" ? "analytics.posts-section-active" : "analytics.posts-section"),
    `analytics_section:posts:${days}`,
  );
  keyboard.text(
    t(locale, section === "video" ? "analytics.video-section-active" : "analytics.video-section"),
    `analytics_section:video:${days}`,
  );
  keyboard.row().text(t(locale, "common.menu"), "menu_home");
  return keyboard;
}

function periodButtonLabel(locale: StudioLocale, period: 1 | 7 | 30, selected: 1 | 7 | 30): string {
  return t(locale, period === selected ? `analytics.period-${period}-active` : `analytics.period-${period}`);
}

/** Page arithmetic follows the page size the archive itself used, so the
 * numbers under a listing cannot disagree with the listing above them. */
function archivePagination(
  keyboard: InlineKeyboard,
  locale: StudioLocale,
  prefix: "analytics_archive" | "analytics_post_archive",
  offset: number,
  archive: { items: Array<unknown>; total: number; pageSize: number },
): void {
  if (!archive.total) return;
  const page = Math.floor(offset / archive.pageSize) + 1;
  const pages = Math.max(1, Math.ceil(archive.total / archive.pageSize));
  if (offset > 0) keyboard.text(t(locale, "analytics.prev"), `${prefix}:${Math.max(0, offset - archive.pageSize)}`);
  keyboard.text(`${page}/${pages}`, "archive_noop");
  if (offset + archive.items.length < archive.total)
    keyboard.text(t(locale, "analytics.next"), `${prefix}:${offset + archive.items.length}`);
  keyboard.row();
}
