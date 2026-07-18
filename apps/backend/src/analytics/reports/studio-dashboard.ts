import type { BackendDb } from "../../db/client.js";
import { creatorProfiles } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale as BotLocale } from "../../foundation/locale.js";
import { t } from "../../interfaces/telegram/i18n/index.js";
import {
  audienceGrowthByAccount,
  type ContentMetrics,
  KEY_SEP,
  siteTotal,
  textContentMetricsByPlatform,
  videoContentMetricsByPlatform,
} from "../metric-deltas.js";
import { metricNumber } from "../snapshots/creator-store.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";
type AnalyticsPeriod = 1 | 7 | 30;

type StudioAnalyticsDashboard = {
  text: string;
  richHtml: string;
  hasComments: boolean;
};

/**
 * Transport-neutral creator analytics. Telegram renders `richHtml` through
 * its Rich Message API, while text remains useful to web and MCP callers.
 */
export function studioAnalyticsDashboard(
  backendDb: BackendDb,
  config: BackendConfig,
  section: AnalyticsSection,
  days: AnalyticsPeriod,
  locale: BotLocale,
): StudioAnalyticsDashboard {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const siteViews = config.studio.modules.site ? siteTotal(backendDb, since) : 0;
  const period = periodLabel(days, locale);
  const updatedAt = latestMeasurement(backendDb, config, section);
  const lines: string[] = [];

  if (section === "overview") {
    lines.push(...audienceTable(backendDb, config, locale, updatedAt));
    if (config.studio.modules.video_posting) lines.push(...videoContentTable(backendDb, config, since, days, period, locale));
    if (config.studio.modules.text_posting) lines.push(...textContentTable(backendDb, since, period, locale));
    if (config.studio.modules.site) lines.push(`${t(locale, "sdash.site-material-views")}: *${siteViews}*`);
  } else if (section === "audience") {
    lines.push(`👥 *${t(locale, "sdash.header-audience", { period })}*`);
    const profiles = audienceProfiles(backendDb, config, since, period, locale);
    lines.push(...(profiles.length ? profiles : [t(locale, "sdash.no-audience")]));
  } else if (section === "posts") {
    lines.push(...audienceTable(backendDb, config, locale, updatedAt));
    lines.push(...textContentTable(backendDb, since, period, locale));
    if (config.studio.modules.site) lines.push(`${t(locale, "sdash.site-material-views")}: *${siteViews}*`);
  } else {
    lines.push(...audienceTable(backendDb, config, locale, updatedAt));
    lines.push(...videoContentTable(backendDb, config, since, days, period, locale));
  }
  const text = lines.join("\n");
  return { text, richHtml: richMessageHtml(lines), hasComments: hasAudienceComments(backendDb) };
}

/** Telegram's new rich-message Markdown deliberately has no table syntax.
 * Use its supported HTML <table> block instead of sending pipe characters as
 * visible text. */
function richMessageHtml(lines: string[]): string {
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    if (line.startsWith("| ")) {
      const headers = tableCells(line);
      // Markdown table separator is only an intermediate text representation.
      index += 1;
      const rows: string[][] = [];
      while (index + 1 < lines.length && (lines[index + 1]?.trimStart().startsWith("| ") ?? false)) {
        index += 1;
        rows.push(tableCells(lines[index] ?? ""));
      }
      blocks.push(
        `<table bordered striped><tr>${headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>${rows
          .map(
            (row) =>
              `<tr>${row.map((cell, cellIndex) => `<td align="${cellIndex ? "right" : "left"}">${escapeHtml(cell)}</td>`).join("")}</tr>`,
          )
          .join("")}</table>`,
      );
      continue;
    }
    blocks.push(`<p>${richInlineHtml(line)}</p>`);
  }
  return blocks.join("\n");
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|\s?/, "")
    .replace(/\s?\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function richInlineHtml(value: string): string {
  return escapeHtml(value).replace(/\*([^*]+)\*/g, "<b>$1</b>");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function audienceProfiles(backendDb: BackendDb, config: BackendConfig, since: string, period: string, locale: BotLocale): string[] {
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
    .filter((row) => enabledAudiencePlatforms(config).has(row.platform))
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
      if (followers != null) values.push(`${t(locale, "sdash.followers-lc")}: *${metricNumber(followers)}*`);
      const deltas = [...growth.entries()].filter(([key]) => key.startsWith(`${row.platform}\u0000`)).map(([, value]) => value);
      const delta = deltas.length ? deltas.reduce((total, value) => total + value, 0) : null;
      if (delta != null) values.push(`${t(locale, "sdash.growth-lc", { period })}: *${delta >= 0 ? "+" : ""}${delta}*`);
      if (data.stars != null) values.push(`Stars: *${metricNumber(data.stars)}*`);
      if (data.averageViewsPerPost != null) values.push(`${t(locale, "sdash.avg-views")}: ${metricNumber(data.averageViewsPerPost)}`);
      if (!values.length) values.push(t(locale, "sdash.no-follower-count"));
      return `• *${labels[row.platform] ?? row.platform}* — ${values.join(" · ")}`;
    });
}

function audienceTable(backendDb: BackendDb, config: BackendConfig, locale: BotLocale, updatedAt: string | null): string[] {
  const profiles = backendDb.db
    .select()
    .from(creatorProfiles)
    .all()
    .filter((row) => enabledAudiencePlatforms(config).has(row.platform));
  if (!profiles.length) return [];
  const labels: Record<string, string> = { instagram: "Instagram", youtube: "YouTube", telegram: "Telegram" };
  const growth = ([1, 7, 30] as const).map((days) =>
    audienceGrowthByAccount(backendDb, new Date(Date.now() - days * 86_400_000).toISOString()),
  );
  const rows = profiles
    .sort((left, right) => (labels[left.platform] ?? left.platform).localeCompare(labels[right.platform] ?? right.platform))
    .map((row) => {
      const current = metricNumber(row.dataJson.subscriberCount ?? row.dataJson.followersCount);
      const values = growth.map((periodGrowth) => sumAccountGrowth(periodGrowth, row.platform));
      return { label: labels[row.platform] ?? row.platform, current, values };
    });
  const total = {
    label: locale === "ru" ? "Все" : "All",
    current: rows.reduce((sum, row) => sum + row.current, 0),
    values: [0, 1, 2].map((index) => rows.reduce((sum, row) => sum + (row.values[index] ?? 0), 0)),
  };
  return [
    `${locale === "ru" ? "Подписчики" : "Followers"}${updatedAt ? ` · ⟳ ${formatDateTime(updatedAt, locale)}` : ""}`,
    `| ${locale === "ru" ? "Площадка" : "Platform"} | ${locale === "ru" ? "Сейчас" : "Now"} | ${locale === "ru" ? "Сегодня" : "Today"} | 7 ${locale === "ru" ? "д" : "d"} | 30 ${locale === "ru" ? "д" : "d"} |`,
    "|:--|--:|--:|--:|--:|",
    ...[total, ...rows].map(
      (row) =>
        `| ${row.label} | ${metricNumber(row.current)} | ${signed(row.values[0] ?? 0)} | ${signed(row.values[1] ?? 0)} | ${signed(row.values[2] ?? 0)} |`,
    ),
  ];
}

function videoContentTable(
  backendDb: BackendDb,
  config: BackendConfig,
  since: string,
  days: AnalyticsPeriod,
  period: string,
  locale: BotLocale,
): string[] {
  const values = videoContentMetricsByPlatform(backendDb, since);
  const accountMetrics = new Map(
    backendDb.db
      .select()
      .from(creatorProfiles)
      .all()
      .map((row) => [row.platform, contentMetricsFromProfile(row.dataJson, days)]),
  );
  const rows = [
    ...(config.studio.modules.instagram
      ? [{ label: "Instagram", value: preferLiveMetrics(accountMetrics.get("instagram"), values.get("instagram_reels")) }]
      : []),
    ...(config.studio.modules.youtube
      ? [{ label: "YouTube", value: preferLiveMetrics(accountMetrics.get("youtube"), values.get("youtube_shorts")) }]
      : []),
  ].map(({ label, value }) => ({ label, value: value ?? { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 } }));
  return contentTable(rows, period, locale);
}

function textContentTable(backendDb: BackendDb, since: string, period: string, locale: BotLocale): string[] {
  const labels: Record<string, string> = {
    telegram: "Telegram",
    facebook_en: "Facebook EN",
    facebook_ru: "Facebook RU",
    threads: "Threads",
    x: "X",
    bluesky: "Bluesky",
    mastodon: "Mastodon",
    devto: "Dev.to",
  };
  return contentTable(
    [...textContentMetricsByPlatform(backendDb, since).entries()].map(([platform, value]) => ({
      label: labels[platform] ?? platform,
      value,
    })),
    period,
    locale,
  );
}

function contentTable(rows: Array<{ label: string; value: ContentMetrics }>, period: string, locale: BotLocale): string[] {
  const total = rows.reduce(
    (sum, row) => ({
      views: sum.views + row.value.views,
      likes: sum.likes + row.value.likes,
      comments: sum.comments + row.value.comments,
      shares: sum.shares + row.value.shares,
      saves: sum.saves + row.value.saves,
    }),
    { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 },
  );
  const all = locale === "ru" ? "Все" : "All";
  return [
    `\n${locale === "ru" ? "Контент" : "Content"} · ${period}`,
    `| ${locale === "ru" ? "Площадка" : "Platform"} | 👁 | ♥ | 💬 | ↗ | 🔖 |`,
    "|:--|--:|--:|--:|--:|--:|",
    ...[{ label: all, value: total }, ...rows].map(
      (row) =>
        `| ${row.label} | ${row.value.views} | ${row.value.likes} | ${row.value.comments} | ${row.value.shares} | ${row.label === "YouTube" ? "—" : row.value.saves} |`,
    ),
  ];
}

function contentMetricsFromProfile(
  data: Record<string, unknown>,
  days: 1 | 7 | 30,
): { views: number; likes: number; comments: number; shares: number; saves: number } | undefined {
  const suffix = `${days}d`;
  const value = (name: string): unknown => data[`${name}${suffix}`] ?? (days === 30 ? data[name] : undefined);
  const views = value("views");
  if (views == null) return undefined;
  return {
    views: metricNumber(views),
    likes: metricNumber(value("likes")),
    comments: metricNumber(value("comments")),
    shares: metricNumber(value("shares")),
    saves: metricNumber(value("saves")),
  };
}

/** YouTube Analytics can take a day to expose a just-published Short while
 * the Data API snapshot already has its live counts. Prefer the latter only
 * when the period aggregate is all zero. */
function preferLiveMetrics(period: ContentMetrics | undefined, fallback: ContentMetrics | undefined): ContentMetrics | undefined {
  if (period && (period.views > 0 || !fallback || fallback.views === 0)) return period;
  return fallback ?? period;
}

function sumAccountGrowth(values: Map<string, number>, platform: string): number {
  return [...values.entries()].filter(([key]) => key.startsWith(`${platform}${KEY_SEP}`)).reduce((sum, [, value]) => sum + value, 0);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function periodLabel(days: AnalyticsPeriod, locale: BotLocale): string {
  if (days === 1) return t(locale, "report.period-today");
  return t(locale, "report.period-days", { days });
}

/** Audience is shown only for platforms this Studio actually publishes to.
 * A controller bot alone must never make its default Telegram channel appear. */
function enabledAudiencePlatforms(config: BackendConfig): Set<string> {
  // Community profiles have their own explicit credentials. Only the three
  // Studio-owned platform projections need module gating here.
  const platforms = new Set(["bluesky", "devto", "facebook_en", "facebook_ru", "github", "mastodon", "threads", "x"]);
  if (config.studio.modules.text_posting) platforms.add("telegram");
  if (config.studio.modules.video_posting && config.studio.modules.youtube) platforms.add("youtube");
  if (config.studio.modules.video_posting && config.studio.modules.instagram) platforms.add("instagram");
  return platforms;
}

function hasAudienceComments(backendDb: BackendDb): boolean {
  return backendDb.sqlite.prepare("SELECT 1 FROM social_comments LIMIT 1").get() != null;
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

function formatDateTime(value: string, locale: BotLocale): string {
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}
