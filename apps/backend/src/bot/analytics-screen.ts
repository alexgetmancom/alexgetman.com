import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale, ui } from "./i18n.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";

/** Telegram adapter for the Analytics Studio screen. The analytics read model itself stays transport-neutral. */
export async function handleAnalyticsCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (data === "analytics_home") {
    await ctx.answerCallbackQuery();
    await showAnalyticsDashboard(ctx, backendDb, config, "overview", 7);
    return true;
  }
  if (data === "archive_home") {
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    const keyboard = new InlineKeyboard().text(ui(locale, "📚 Post archive", "📚 Архив постов"), "analytics_post_archive:0");
    if (config.studio.modules.video_posting) keyboard.row().text(ui(locale, "🎬 Video archive", "🎬 Архив роликов"), "analytics_archive:0");
    keyboard.row().text(ui(locale, "← Menu", "← Меню"), "menu_home");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ui(locale, "📚 Archive", "📚 Архив"), { reply_markup: keyboard });
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
    if (archive.hasMore) keyboard.text(ui(locale, "More", "Ещё"), `analytics_archive:${offset + archive.items.length}`).row();
    keyboard
      .text(ui(locale, "← Video", "← Видеопостинг"), "analytics_section:video:7")
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
    if (archive.hasMore) keyboard.text(ui(locale, "More", "Ещё"), `analytics_post_archive:${offset + archive.items.length}`).row();
    keyboard
      .text(ui(locale, "← Posts", "← Постинг"), "analytics_section:posts:7")
      .row()
      .text(ui(locale, "← Menu", "← Меню"), "menu_home");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(archive.text, { reply_markup: keyboard });
    return true;
  }
  if (data.startsWith("analytics_post:")) {
    const id = Number(data.slice("analytics_post:".length));
    const locale = botLocale(backendDb, Number(ctx.from?.id));
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(studioServices(backendDb, config).analytics.postMetrics(id, locale), {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text(ui(locale, "← Archive", "← Архив"), "analytics_post_archive:0")
        .row()
        .text(ui(locale, "← Menu", "← Меню"), "menu_home"),
    });
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
  if (section !== "overview") keyboard.text(ui(locale, "📊 Overview", "📊 Общая"), "analytics_section:overview:7");
  if (section !== "audience") keyboard.text(ui(locale, "👥 Audience", "👥 Аудитория"), "analytics_section:audience:7");
  if (config.studio.modules.text_posting && section !== "posts")
    keyboard.text(ui(locale, "📝 Posts", "📝 Постинг"), "analytics_section:posts:7");
  if (config.studio.modules.video_posting && section !== "video")
    keyboard.text(ui(locale, "🎬 Video", "🎬 Видеопостинг"), "analytics_section:video:7");
  if (section === "posts") keyboard.row().text(ui(locale, "📚 Post archive", "📚 Архив постов"), "analytics_post_archive:0");
  if (section === "video") {
    keyboard.row().text(ui(locale, "📚 Video archive", "📚 Архив роликов"), "analytics_archive:0");
    if (dashboard.hasComments && config.DEEPSEEK_API_KEY)
      keyboard.text(ui(locale, "🤖 AI audience analysis", "🤖 ИИ-анализ аудитории"), "analytics_ai");
  }
  keyboard.row().text(ui(locale, "← Menu", "← Меню"), "menu_home");
  await ctx.editMessageText(dashboard.text, { parse_mode: "Markdown", reply_markup: keyboard });
}
