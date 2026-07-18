import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { sendTelegramArchiveMedia } from "../interfaces/telegram/delivery-previews.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";

/** Telegram adapter for the Analytics Studio screen. The analytics read model itself stays transport-neutral. */
export async function handleAnalyticsCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
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
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    const summary = studioServices(backendDb, config).analytics.archiveSummary(locale);
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
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    const archive = studioServices(backendDb, config).analytics.videoArchive(offset, locale);
    const keyboard = new InlineKeyboard();
    for (const item of archive.items) keyboard.text(item.label, `analytics_video:${item.id}`).row();
    archivePagination(keyboard, locale, "analytics_archive", offset, archive.items.length, archive.total);
    keyboard.text(t(locale, "analytics.back-archive"), "archive_home").row().text(t(locale, "common.menu"), "menu_home");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(archive.text, { reply_markup: keyboard });
    return true;
  }
  if (data.startsWith("analytics_video:")) {
    const id = Number(data.slice("analytics_video:".length));
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(studioServices(backendDb, config).analytics.videoMetrics(id, locale), {
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
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    const archive = studioServices(backendDb, config).analytics.postArchive(offset, locale);
    const keyboard = new InlineKeyboard();
    for (const item of archive.items) keyboard.text(item.label, `analytics_post:${item.id}`).row();
    archivePagination(keyboard, locale, "analytics_post_archive", offset, archive.items.length, archive.total);
    keyboard.text(t(locale, "analytics.back-archive"), "archive_home").row().text(t(locale, "common.menu"), "menu_home");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(archive.text, { reply_markup: keyboard });
    return true;
  }
  if (data.startsWith("analytics_post:")) {
    const id = Number(data.slice("analytics_post:".length));
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    const media = studioServices(backendDb, config).analytics.postMedia(id, locale);
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    if (media.length) keyboard.text(t(locale, "analytics.show-media"), `analytics_post_media:${id}`).row();
    keyboard.text(t(locale, "analytics.back-archive"), "analytics_post_archive:0").row().text(t(locale, "common.menu"), "menu_home");
    await ctx.editMessageText(studioServices(backendDb, config).analytics.postMetrics(id, locale), {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    return true;
  }
  if (data.startsWith("analytics_post_media:")) {
    const id = Number(data.slice("analytics_post_media:".length));
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery();
    if (Number.isSafeInteger(id)) await sendTelegramArchiveMedia(ctx, studioServices(backendDb, config).analytics.postMedia(id, locale));
    return true;
  }
  if (data !== "analytics_ai") return false;
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  await ctx.answerCallbackQuery({ text: t(locale, "analytics.preparing-report") });
  const report = await studioServices(backendDb, config).analytics.audienceAnalysis(locale);
  await ctx.editMessageText(report, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text(t(locale, "analytics.back-video"), "analytics_section:video:7"),
  });
  return true;
}

function analyticsPeriod(value: number): 1 | 7 | 30 {
  return value === 1 || value === 30 ? value : 7;
}

async function showAnalyticsDashboard(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  section: AnalyticsSection,
  days: 1 | 7 | 30,
): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  const dashboard = studioServices(backendDb, config).analytics.dashboard(section, days, locale);
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
  keyboard.row().text(t(locale, "analytics.archive-btn"), "archive_home");
  if (dashboard.hasComments && config.DEEPSEEK_API_KEY) keyboard.text(t(locale, "analytics.ai-analysis"), "analytics_ai");
  keyboard.row().text(t(locale, "common.menu"), "menu_home");
  await ctx.editMessageText({ html: dashboard.richHtml }, { reply_markup: keyboard });
}

function defaultAnalyticsSection(config: BackendConfig): AnalyticsSection {
  const preferred = config.studio.analytics.defaultTab;
  if (preferred === "posts" && config.studio.modules.text_posting) return preferred;
  if (preferred === "video" && config.studio.modules.video_posting) return preferred;
  return "overview";
}

function showOverview(config: BackendConfig): boolean {
  return config.studio.modules.text_posting && config.studio.modules.video_posting;
}

function periodButtonLabel(locale: ReturnType<typeof botLocale>, period: 1 | 7 | 30, selected: 1 | 7 | 30): string {
  const key = period === 1 ? "common.today" : period === 7 ? "analytics.7-days" : "analytics.30-days";
  return `${period === selected ? "• " : ""}${t(locale, key)}`;
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
