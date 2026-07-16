import type { BackendDb } from "../../db/client.js";
import { analyticsSync, creatorProfiles } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { type StudioLocale as BotLocale, localize as ui } from "../../foundation/locale.js";
import { metricNumber } from "../snapshots/creator-store.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";
type AnalyticsPeriod = 1 | 7 | 30;

type StudioAnalyticsDashboard = {
  text: string;
  hasComments: boolean;
};

type VideoMetricRow = {
  platform: string;
  metrics: Record<string, unknown>;
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
function audienceGrowthByAccount(backendDb: BackendDb, since: string): Map<string, number> {
  const rows = backendDb.sqlite
    .prepare(
      "SELECT platform, account, metrics_json, sampled_at, id FROM creator_profile_snapshots ORDER BY platform, account, sampled_at ASC, id ASC",
    )
    .all() as Array<{ platform: string; account: string; metrics_json: string; sampled_at: string }>;
  const byAccount = new Map<string, { latest: number; baseline: number | null }>();
  for (const row of rows) {
    const data = JSON.parse(row.metrics_json) as Record<string, unknown>;
    const key = `${row.platform}\u0000${row.account}`;
    const entry = byAccount.get(key) ?? { latest: 0, baseline: null };
    const value = metricNumber(data.subscriberCount ?? data.followersCount);
    entry.latest = value;
    if (row.sampled_at <= since) entry.baseline = value;
    byAccount.set(key, entry);
  }
  return new Map(
    [...byAccount.entries()]
      .filter(([, values]) => values.baseline != null)
      .map(([key, values]) => [key, values.latest - (values.baseline ?? values.latest)]),
  );
}

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

function textTotals(backendDb: BackendDb, since: string): { views: number; interactions: number } {
  const totals = metricDeltasSince(backendDb, since, "target NOT LIKE 'site_%'");
  return {
    views: totals.views ?? 0,
    interactions: (totals.likes ?? 0) + (totals.replies ?? 0) + (totals.reposts ?? 0) + (totals.comments ?? 0),
  };
}

function siteTotal(backendDb: BackendDb, since: string): number {
  return metricDeltasSince(backendDb, since, "target LIKE 'site_%'").views ?? 0;
}

function videoTotals(backendDb: BackendDb, since: string): { views: number; interactions: number } {
  const rows = latestVideoMetrics(backendDb, since);
  return {
    views: sum(rows, "views"),
    interactions: sum(rows, "likes") + sum(rows, "comments"),
  };
}

function metricDeltasSince(backendDb: BackendDb, since: string, where: string): Record<string, number> {
  const rows = backendDb.sqlite
    .prepare(`SELECT post_key, target, metric_name, value, sampled_at FROM metric_samples WHERE ${where} ORDER BY sampled_at ASC, id ASC`)
    .all() as Array<{ post_key: string; target: string; metric_name: string; value: number | null; sampled_at: string }>;
  const series = new Map<string, { metric: string; firstAt: string; latest: number; baseline: number | null }>();
  for (const row of rows) {
    const key = `${row.post_key}\u0000${row.target}\u0000${row.metric_name}`;
    const value = metricNumber(row.value);
    const entry = series.get(key) ?? { metric: row.metric_name, firstAt: row.sampled_at, latest: value, baseline: null };
    entry.latest = value;
    if (row.sampled_at <= since) entry.baseline = value;
    series.set(key, entry);
  }
  const totals: Record<string, number> = {};
  for (const entry of series.values()) {
    if (entry.baseline == null && entry.firstAt < since) continue;
    totals[entry.metric] = (totals[entry.metric] ?? 0) + Math.max(0, entry.latest - (entry.baseline ?? 0));
  }
  return totals;
}

function latestVideoMetrics(backendDb: BackendDb, since: string): VideoMetricRow[] {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT target.target AS platform, target.published_at, latest.metrics_json AS latest_metrics, baseline.metrics_json AS baseline_metrics FROM video_targets target JOIN video_metric_snapshots latest ON latest.id = (SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id ORDER BY sampled_at DESC, id DESC LIMIT 1) LEFT JOIN video_metric_snapshots baseline ON baseline.id = (SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id AND sampled_at <= ? ORDER BY sampled_at DESC, id DESC LIMIT 1) WHERE target.status = 'published' ORDER BY latest.id DESC`,
    )
    .all(since) as Array<{ platform: string; published_at: string | null; latest_metrics: string; baseline_metrics: string | null }>;
  return rows.flatMap((row) => {
    const latest = JSON.parse(row.latest_metrics) as Record<string, unknown>;
    const baseline = row.baseline_metrics ? (JSON.parse(row.baseline_metrics) as Record<string, unknown>) : null;
    if (!baseline && !(row.published_at != null && row.published_at >= since)) return [];
    return [
      {
        platform: row.platform,
        metrics: Object.fromEntries(
          Object.entries(latest).map(([key, value]) => [key, Math.max(0, metricNumber(value) - metricNumber(baseline?.[key]))]),
        ),
      },
    ];
  });
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

function sum(rows: VideoMetricRow[], field: string): number {
  return rows.reduce((total, row) => total + metricNumber(row.metrics[field]), 0);
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
