import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { sendTelegramArchiveMedia } from "../interfaces/telegram/delivery-previews.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale, ui } from "./i18n.js";

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
    await showAnalyticsDashboard(ctx, backendDb, config, "overview", 7);
    return true;
  }
  if (data === "archive_home") {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    const summary = studioServices(backendDb, config).analytics.archiveSummary(locale);
    const keyboard = new InlineKeyboard().text(
      ui(locale, `📝 Posts · ${summary.posts}`, `📝 Посты · ${summary.posts}`),
      "analytics_post_archive:0",
    );
    if (config.studio.modules.video_posting)
      keyboard.row().text(ui(locale, `🎬 Videos · ${summary.videos}`, `🎬 Ролики · ${summary.videos}`), "analytics_archive:0");
    keyboard.row().text(ui(locale, "← Menu", "← Меню"), "menu_home");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(summary.text, { parse_mode: "Markdown", reply_markup: keyboard });
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
    const section: AnalyticsSection =
      sectionValue === "audience" || sectionValue === "posts" || sectionValue === "video" ? sectionValue : "overview";
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
    keyboard
      .text(ui(locale, "← Archive", "← Архив"), "archive_home")
      .row()
      .text(ui(locale, "← Menu", "← Меню"), "menu_home");
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
        .text(ui(locale, "← Archive", "← Архив"), "analytics_archive:0")
        .row()
        .text(ui(locale, "← Menu", "← Меню"), "menu_home"),
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
    keyboard
      .text(ui(locale, "← Archive", "← Архив"), "archive_home")
      .row()
      .text(ui(locale, "← Menu", "← Меню"), "menu_home");
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
    if (media.length) keyboard.text(ui(locale, "🖼 Show media", "🖼 Показать медиа"), `analytics_post_media:${id}`).row();
    keyboard
      .text(ui(locale, "← Archive", "← Архив"), "analytics_post_archive:0")
      .row()
      .text(ui(locale, "← Menu", "← Меню"), "menu_home");
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
  await ctx.answerCallbackQuery({ text: ui(locale, "Preparing report…", "Готовлю отчёт…") });
  const report = await studioServices(backendDb, config).analytics.audienceAnalysis(locale);
  await ctx.editMessageText(report, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text(ui(locale, "← Video analytics", "← К статистике видео"), "analytics_section:video:7"),
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
    .text(ui(locale, "Today", "Сегодня"), callback(1))
    .text(ui(locale, "7 days", "7 дней"), callback(7))
    .text(ui(locale, "30 days", "30 дней"), callback(30))
    .row();
  keyboard
    .text(
      ui(locale, section === "overview" ? "• Overview" : "📊 Overview", section === "overview" ? "• Общая" : "📊 Общая"),
      `analytics_section:overview:${days}`,
    )
    .text(
      ui(locale, section === "audience" ? "• Audience" : "👥 Audience", section === "audience" ? "• Аудитория" : "👥 Аудитория"),
      `analytics_section:audience:${days}`,
    )
    .text(
      ui(locale, section === "posts" ? "• Posts" : "📝 Posts", section === "posts" ? "• Постинг" : "📝 Постинг"),
      `analytics_section:posts:${days}`,
    )
    .row()
    .text(ui(locale, "📚 Archive", "📚 Архив"), "archive_home");
  if (config.studio.modules.video_posting)
    keyboard.text(
      ui(locale, section === "video" ? "• Video" : "🎬 Video", section === "video" ? "• Видео" : "🎬 Видео"),
      `analytics_section:video:${days}`,
    );
  if (section === "video" && dashboard.hasComments && config.DEEPSEEK_API_KEY)
    keyboard.row().text(ui(locale, "🤖 AI audience analysis", "🤖 ИИ-анализ аудитории"), "analytics_ai");
  keyboard.row().text(ui(locale, "← Menu", "← Меню"), "menu_home");
  await ctx.editMessageText(dashboard.text, { parse_mode: "Markdown", reply_markup: keyboard });
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
  if (offset > 0) keyboard.text(ui(locale, "← Previous", "← Назад"), `${prefix}:${Math.max(0, offset - 10)}`);
  keyboard.text(`${page}/${pages}`, "archive_noop");
  if (offset + count < total) keyboard.text(ui(locale, "Next →", "Вперёд →"), `${prefix}:${offset + count}`);
  keyboard.row();
}
