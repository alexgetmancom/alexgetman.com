import type { BackendDb } from "../../db/client.js";
import { analyticsSync, creatorProfiles } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { type StudioLocale as BotLocale, localize as ui } from "../../foundation/locale.js";
import { audienceGrowthByAccount, siteTotal, textTotals, videoTotals } from "../metric-deltas.js";
import { metricNumber } from "../snapshots/creator-store.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";
type AnalyticsPeriod = 1 | 7 | 30;

type StudioAnalyticsDashboard = {
  text: string;
  hasComments: boolean;
};

/**
 * Compact, transport-neutral creator analytics for Studio surfaces. It deliberately
 * keeps platform detail out of the first card; Telegram, web and MCP can request
 * a section or an individual archive item afterwards.
 */
export function studioAnalyticsDashboard(
  backendDb: BackendDb,
  config: BackendConfig,
  section: AnalyticsSection,
  days: AnalyticsPeriod,
  locale: BotLocale,
): StudioAnalyticsDashboard {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const post = config.studio.modules.text_posting ? textTotals(backendDb, since) : emptyTotals();
  const video = config.studio.modules.video_posting ? videoTotals(backendDb, since) : emptyTotals();
  const siteViews = config.studio.modules.site ? siteTotal(backendDb, since) : 0;
  const period = periodLabel(days, locale);
  const lines = [header(section, period, locale)];

  if (section === "overview") {
    const followers = socialFollowers(backendDb, config);
    if (followers != null) lines.push(`${ui(locale, "👥 Followers across platforms", "👥 Подписчики по площадкам")}: *${followers}*`);
    const growth = audienceGrowth(backendDb, since);
    if (growth != null)
      lines.push(
        `${ui(locale, `📈 Follower growth · ${period}`, `📈 Прирост подписчиков · ${period}`)}: *${growth >= 0 ? "+" : ""}${growth}*`,
      );
    lines.push(`${ui(locale, "👁 Content views", "👁 Просмотры контента")}: *${post.views + video.views}*`);
    lines.push(`${ui(locale, "💬 Interactions", "💬 Взаимодействия")}: *${post.interactions + video.interactions}*`);
    if (config.studio.modules.site) lines.push(`${ui(locale, "🌐 Site material views", "🌐 Просмотры материалов сайта")}: *${siteViews}*`);
    const stale = staleSources(backendDb);
    if (stale.length) lines.push(`\n⚠️ ${ui(locale, "Data attention", "Проверить данные")}: ${stale.join(", ")}`);
  } else if (section === "audience") {
    const profiles = audienceProfiles(backendDb, since, period, locale);
    lines.push(
      ...(profiles.length ? profiles : [ui(locale, "Audience data has not been collected yet.", "Данные об аудитории ещё не собраны.")]),
    );
  } else if (section === "posts") {
    lines.push(`${ui(locale, "📝 Post views", "📝 Просмотры постов")}: *${post.views}*`);
    lines.push(`${ui(locale, "💬 Interactions", "💬 Реакции")}: *${post.interactions}*`);
    if (config.studio.modules.site) lines.push(`${ui(locale, "🌐 Site material views", "🌐 Просмотры материалов сайта")}: *${siteViews}*`);
  } else {
    lines.push(`${ui(locale, "🎬 Video views", "🎬 Просмотры роликов")}: *${video.views}*`);
    lines.push(`${ui(locale, "💬 Interactions", "💬 Взаимодействия")}: *${video.interactions}*`);
  }

  const coverage = earliestMeasurement(backendDb, config, section);
  if (coverage && coverage > since) {
    lines.push(
      `\n⚠️ ${ui(
        locale,
        `History has been collected since ${formatDate(coverage, locale)}. The ${period} comparison is not complete yet.`,
        `История собирается с ${formatDate(coverage, locale)}. Сравнение за ${period} пока неполное.`,
      )}`,
    );
  }
  const updatedAt = latestMeasurement(backendDb, config, section);
  if (updatedAt) lines.push(`\n${ui(locale, "Updated", "Обновлено")}: ${formatDateTime(updatedAt, locale)}`);
  return { text: lines.join("\n"), hasComments: hasAudienceComments(backendDb) };
}

function header(section: AnalyticsSection, period: string, locale: BotLocale): string {
  if (section === "audience") return `👥 *${ui(locale, `Audience · ${period}`, `Аудитория · ${period}`)}*`;
  if (section === "posts") return `📝 *${ui(locale, `Posts · ${period}`, `Постинг · ${period}`)}*`;
  if (section === "video") return `🎬 *${ui(locale, `Video · ${period}`, `Видеопостинг · ${period}`)}*`;
  return `📊 *${ui(locale, `Overview · ${period}`, `Общая статистика · ${period}`)}*`;
}

function audienceProfiles(backendDb: BackendDb, since: string, period: string, locale: BotLocale): string[] {
  const labels: Record<string, string> = {
    bluesky: "Bluesky",
    devto: "Dev.to",
    facebook_en: "Facebook EN",
    facebook_ru: "Facebook RU",
    github: "GitHub",
    instagram: "Instagram",
    mastodon: "Mastodon",
    telegram: "Telegram",
    threads: "Threads",
    x: "X",
    youtube: "YouTube",
  };
  const growth = audienceGrowthByAccount(backendDb, since);
  return backendDb.db
    .select()
    .from(creatorProfiles)
    .all()
    .sort((left, right) => {
      const rightFollowers = metricNumber(right.dataJson.subscriberCount ?? right.dataJson.followersCount);
      const leftFollowers = metricNumber(left.dataJson.subscriberCount ?? left.dataJson.followersCount);
      return (
        rightFollowers - leftFollowers || (labels[left.platform] ?? left.platform).localeCompare(labels[right.platform] ?? right.platform)
      );
    })
    .map((row) => {
      const data = row.dataJson as Record<string, unknown>;
      const followers = data.subscriberCount ?? data.followersCount;
      const values: string[] = [];
      if (followers != null) values.push(`${ui(locale, "followers", "подписчики")}: *${metricNumber(followers)}*`);
      const deltas = [...growth.entries()].filter(([key]) => key.startsWith(`${row.platform}\u0000`)).map(([, value]) => value);
      const delta = deltas.length ? deltas.reduce((total, value) => total + value, 0) : null;
      if (delta != null) values.push(`${ui(locale, `growth · ${period}`, `прирост · ${period}`)}: *${delta >= 0 ? "+" : ""}${delta}*`);
      if (data.stars != null) values.push(`Stars: *${metricNumber(data.stars)}*`);
      if (data.averageViewsPerPost != null)
        values.push(`${ui(locale, "avg. views/post", "ср. просмотров/пост")}: ${metricNumber(data.averageViewsPerPost)}`);
      if (!values.length)
        values.push(ui(locale, "profile connected; follower count unavailable", "профиль подключён; число подписчиков недоступно"));
      return `• *${labels[row.platform] ?? row.platform}* — ${values.join(" · ")}`;
    });
}

function periodLabel(days: AnalyticsPeriod, locale: BotLocale): string {
  if (days === 1) return ui(locale, "today", "сегодня");
  return ui(locale, `${days} days`, `${days} дней`);
}

function socialFollowers(backendDb: BackendDb, config: BackendConfig): number | null {
  if (!config.studio.modules.analytics) return null;
  const values = backendDb.db
    .select()
    .from(creatorProfiles)
    .all()
    .map((row) => metricNumber(row.dataJson.subscriberCount ?? row.dataJson.followersCount));
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function audienceGrowth(backendDb: BackendDb, since: string): number | null {
  const values = [...audienceGrowthByAccount(backendDb, since).values()];
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

/** Current projection minus the last observation at or before the selected period.
 * A profile with no baseline is intentionally omitted instead of pretending that
 * its lifetime follower number is growth. */
function staleSources(backendDb: BackendDb): string[] {
  return backendDb.db
    .select()
    .from(analyticsSync)
    .all()
    .filter((row) => row.lastError)
    .map((row) => row.source)
    .slice(0, 3);
}

function hasAudienceComments(backendDb: BackendDb): boolean {
  return backendDb.sqlite.prepare("SELECT 1 FROM social_comments LIMIT 1").get() != null;
}

function emptyTotals(): { views: number; interactions: number } {
  return { views: 0, interactions: 0 };
}

function earliestMeasurement(backendDb: BackendDb, config: BackendConfig, section: AnalyticsSection): string | null {
  const candidates: string[] = [];
  if (section !== "video" && (config.studio.modules.text_posting || config.studio.modules.site)) {
    const where = section === "posts" ? "target NOT LIKE 'site_%'" : "1=1";
    const value = backendDb.sqlite.prepare(`SELECT MIN(sampled_at) AS value FROM metric_samples WHERE ${where}`).get() as {
      value: string | null;
    };
    if (value.value) candidates.push(value.value);
  }
  if (section !== "posts" && config.studio.modules.video_posting) {
    const value = backendDb.sqlite.prepare("SELECT MIN(sampled_at) AS value FROM video_metric_snapshots").get() as { value: string | null };
    if (value.value) candidates.push(value.value);
  }
  return candidates.sort()[0] ?? null;
}

function latestMeasurement(backendDb: BackendDb, config: BackendConfig, section: AnalyticsSection): string | null {
  const candidates: string[] = [];
  if (section !== "video" && (config.studio.modules.text_posting || config.studio.modules.site)) {
    const where = section === "posts" ? "target NOT LIKE 'site_%'" : "1=1";
    const value = backendDb.sqlite.prepare(`SELECT MAX(sampled_at) AS value FROM metric_samples WHERE ${where}`).get() as {
      value: string | null;
    };
    if (value.value) candidates.push(value.value);
  }
  if (section !== "posts" && config.studio.modules.video_posting) {
    const value = backendDb.sqlite.prepare("SELECT MAX(sampled_at) AS value FROM video_metric_snapshots").get() as { value: string | null };
    if (value.value) candidates.push(value.value);
  }
  return candidates.sort().at(-1) ?? null;
}

function formatDate(value: string, locale: BotLocale): string {
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", timeZone: "Europe/Moscow" }).format(
    new Date(value),
  );
}

function formatDateTime(value: string, locale: BotLocale): string {
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}
