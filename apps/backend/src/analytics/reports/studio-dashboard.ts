import type { BackendDb } from "../../db/client.js";
import { creatorProfiles } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale as BotLocale } from "../../foundation/locale.js";
import { t } from "../../interfaces/telegram/i18n/index.js";
import {
  audienceGrowthByPlatform,
  type ContentMetrics,
  latestTextPostMetrics,
  latestVideoMetrics,
  textContentMetricsByPlatform,
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
  const period = periodLabel(days, locale);
  const lines: string[] = [];

  if (section === "audience") {
    lines.push(`👥 *${t(locale, "sdash.header-audience", { period })}*`);
    const profiles = audienceProfiles(backendDb, config, since, days, period, locale);
    lines.push(...(profiles.length ? profiles : [t(locale, "sdash.no-audience")]));
  } else {
    lines.push(...unifiedAnalyticsTable(backendDb, config, section, since, days, locale));
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

function audienceProfiles(
  backendDb: BackendDb,
  config: BackendConfig,
  since: string,
  days: AnalyticsPeriod,
  period: string,
  locale: BotLocale,
): string[] {
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
  const growth = audienceGrowthByPlatform(backendDb, since, days);
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
      const delta = growth.get(row.platform) ?? null;
      if (delta != null) values.push(`${t(locale, "sdash.growth-lc", { period })}: *${delta >= 0 ? "+" : ""}${delta}*`);
      if (data.stars != null) values.push(`Stars: *${metricNumber(data.stars)}*`);
      if (data.averageViewsPerPost != null) values.push(`${t(locale, "sdash.avg-views")}: ${metricNumber(data.averageViewsPerPost)}`);
      if (!values.length) values.push(t(locale, "sdash.no-follower-count"));
      return `• *${labels[row.platform] ?? row.platform}* — ${values.join(" · ")}`;
    });
}

function unifiedAnalyticsTable(
  backendDb: BackendDb,
  config: BackendConfig,
  section: Exclude<AnalyticsSection, "audience">,
  since: string,
  days: AnalyticsPeriod,
  locale: BotLocale,
): string[] {
  const profiles = backendDb.db
    .select()
    .from(creatorProfiles)
    .all()
    .filter((row) => audiencePlatformsForSection(config, section).has(row.platform));
  const accountMetrics = new Map(profiles.map((row) => [row.platform, contentMetricsFromProfile(row.dataJson, days)]));
  const content = accountContentMetricsForSection(backendDb, config, section, since, accountMetrics);
  const growth = audienceGrowthByPlatform(backendDb, since, days);
  const profileMap = new Map(profiles.map((profile) => [profile.platform, profile]));
  const platforms = new Set([...profileMap.keys(), ...content.keys()]);
  const rows = [...platforms]
    .sort(
      (left, right) =>
        (content.get(right)?.views ?? 0) - (content.get(left)?.views ?? 0) || platformLabel(left).localeCompare(platformLabel(right)),
    )
    .map((platform) => ({
      platform,
      growth: profileMap.has(platform) ? (growth.get(platform) ?? 0) : null,
      value: content.get(platform) ?? emptyMetrics(),
    }));
  const totalContent = rows.reduce(
    (sum, row) => ({
      views: sum.views + row.value.views,
      likes: sum.likes + row.value.likes,
      comments: sum.comments + row.value.comments,
      shares: sum.shares + row.value.shares,
      saves: sum.saves + row.value.saves,
    }),
    emptyMetrics(),
  );
  const totalFollowers = profiles.reduce((sum, row) => sum + metricNumber(row.dataJson.subscriberCount ?? row.dataJson.followersCount), 0);
  const totalGrowth = rows.reduce((sum, row) => sum + (row.growth ?? 0), 0);
  const platformSummary = profiles
    .filter((profile) => metricNumber(profile.dataJson.subscriberCount ?? profile.dataJson.followersCount) > 0)
    .sort(
      (left, right) =>
        metricNumber(right.dataJson.subscriberCount ?? right.dataJson.followersCount) -
        metricNumber(left.dataJson.subscriberCount ?? left.dataJson.followersCount),
    )
    .map(
      (profile) =>
        `${platformIcon(profile.platform)} ${platformLabel(profile.platform)} ${metricNumber(profile.dataJson.subscriberCount ?? profile.dataJson.followersCount)}`,
    )
    .join(" · ");
  const all = locale === "ru" ? "Все" : "All";
  return [
    `👥 ${locale === "ru" ? "Подписчики" : "Followers"} ${totalFollowers}${platformSummary ? ` · ${platformSummary}` : ""}`,
    `| ${locale === "ru" ? "Площадка" : "Platform"} | 👤 | 👁 | ♥ | 💬 | ↗ | 🔖 |`,
    "|:--|--:|--:|--:|--:|--:|--:|",
    ...[
      { platform: "all", label: `📊 ${all}`, growth: totalGrowth, value: totalContent },
      ...rows.map((row) => ({ label: `${platformIcon(row.platform)} ${platformLabel(row.platform)}`, ...row })),
    ].map(
      (row) =>
        `| ${row.label} | ${row.growth == null ? "—" : signed(row.growth)} | ${row.value.views} | ${row.value.likes} | ${row.value.comments} | ${row.value.shares} | ${row.platform === "youtube" ? "—" : row.value.saves} |`,
    ),
    ...(section === "posts"
      ? publishedPostTable(backendDb, config, since, locale)
      : publishedVideoTable(backendDb, config, section, since, locale)),
  ];
}

function publishedPostTable(backendDb: BackendDb, config: BackendConfig, since: string, locale: BotLocale): string[] {
  if (!config.studio.modules.text_posting) return [];
  const rows = latestTextPostMetrics(backendDb, since).filter((row) => Object.keys(row.metrics).length > 0);
  if (!rows.length) return [];
  const values = rows.map(contentMetrics);
  const total = sumContentMetrics(values);
  const all = locale === "ru" ? "Все" : "All";
  return [
    `| ${locale === "ru" ? "Пост" : "Post"} | 👁 | ♥ | 💬 | ↗ | 🔖 |`,
    "|:--|--:|--:|--:|--:|--:|",
    `| ${all} | ${total.views} | ${total.likes} | ${total.comments} | ${dash(total.shares)} | ${dash(total.saves)} |`,
    ...rows.map((row) => contentRow(`${shortLabel(row.label)} · ${platformIcon(row.platform)}`, contentMetrics(row))),
  ];
}

/** Account insights describe all content viewed during the selected period.
 * Never use per-video snapshots here: they describe only newly published
 * videos and are rendered in their own table below. */
function accountContentMetricsForSection(
  backendDb: BackendDb,
  config: BackendConfig,
  section: Exclude<AnalyticsSection, "audience">,
  since: string,
  accountMetrics: Map<string, ContentMetrics | undefined>,
): Map<string, ContentMetrics> {
  const values = new Map<string, ContentMetrics>();
  if (section !== "posts" && config.studio.modules.video_posting) {
    if (config.studio.modules.instagram) values.set("instagram", accountMetrics.get("instagram") ?? emptyMetrics());
    if (config.studio.modules.youtube) values.set("youtube", accountMetrics.get("youtube") ?? emptyMetrics());
  }
  if (section !== "video" && config.studio.modules.text_posting)
    for (const [platform, metrics] of textContentMetricsByPlatform(backendDb, since)) values.set(platform, metrics);
  return values;
}

/** Individual rows answer a different question from account insights: how are
 * videos published in the selected period performing since they went live? */
function publishedVideoTable(
  backendDb: BackendDb,
  config: BackendConfig,
  section: Exclude<AnalyticsSection, "audience">,
  since: string,
  locale: BotLocale,
): string[] {
  if (section === "posts" || !config.studio.modules.video_posting) return [];
  const rows = latestVideoMetrics(backendDb, since)
    .filter((row) => row.publishedAt != null && row.publishedAt >= since)
    .filter((row) =>
      row.platform === "instagram_reels"
        ? config.studio.modules.instagram
        : row.platform === "youtube_shorts" && config.studio.modules.youtube,
    )
    // A target with no observed metric is normally a removed or rolled-back
    // publication; it must not look like a real zero-performance video.
    .filter((row) => Object.values(contentMetrics(row)).some((value) => value > 0))
    .sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""));
  if (!rows.length) return [];
  const values = rows.map((row) => contentMetrics(row));
  const total = sumContentMetrics(values);
  const all = locale === "ru" ? "Все" : "All";
  return [
    `| ${locale === "ru" ? "Видео" : "Video"} | 👁 | ♥ | 💬 | ↗ | 🔖 |`,
    "|:--|--:|--:|--:|--:|--:|",
    `| ${all} | ${total.views} | ${total.likes} | ${total.comments} | ${dash(total.shares)} | ${dash(total.saves)} |`,
    ...rows.map((row) => {
      const platform = row.platform === "instagram_reels" ? "instagram" : "youtube";
      return contentRow(`${shortLabel(row.label)} · ${platformIcon(platform)}`, contentMetrics(row), platform === "youtube");
    }),
  ];
}

function contentMetrics(row: { metrics: Record<string, unknown> }): ContentMetrics {
  return {
    views: metricNumber(row.metrics.views),
    likes: metricNumber(row.metrics.likes),
    comments: metricNumber(row.metrics.comments) + metricNumber(row.metrics.replies),
    shares: metricNumber(row.metrics.shares) + metricNumber(row.metrics.reposts),
    saves: metricNumber(row.metrics.saves),
  };
}

function sumContentMetrics(values: ContentMetrics[]): ContentMetrics {
  return values.reduce(
    (sum, value) => ({
      views: sum.views + value.views,
      likes: sum.likes + value.likes,
      comments: sum.comments + value.comments,
      shares: sum.shares + value.shares,
      saves: sum.saves + value.saves,
    }),
    emptyMetrics(),
  );
}

function contentRow(label: string, metrics: ContentMetrics, hidesSaves = false): string {
  return `| ${label} | ${metrics.views} | ${metrics.likes} | ${metrics.comments} | ${dash(metrics.shares)} | ${hidesSaves ? "—" : dash(metrics.saves)} |`;
}

function dash(value: number): string {
  return value === 0 ? "—" : String(value);
}

function shortLabel(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 10 ? `${compact.slice(0, 9)}…` : compact || "—";
}

function audiencePlatformsForSection(config: BackendConfig, section: Exclude<AnalyticsSection, "audience">): Set<string> {
  const enabled = enabledAudiencePlatforms(config);
  if (section === "video") return new Set(["instagram", "youtube"].filter((platform) => enabled.has(platform)));
  if (section === "posts") return new Set([...enabled].filter((platform) => platform !== "instagram" && platform !== "youtube"));
  return enabled;
}

function emptyMetrics(): ContentMetrics {
  return { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
}

function platformLabel(platform: string): string {
  return (
    {
      bluesky: "Bluesky",
      devto: "Dev.to",
      facebook: "Facebook EN",
      facebook_en: "Facebook EN",
      facebook_ru: "Facebook RU",
      github: "GitHub",
      github_en: "GitHub EN",
      github_ru: "GitHub RU",
      instagram: "Instagram",
      mastodon: "Mastodon",
      telegram: "Telegram",
      threads: "Threads",
      threads_en: "Threads EN",
      threads_ru: "Threads RU",
      x: "X",
      youtube: "YouTube",
    }[platform] ?? platform
  );
}

function platformIcon(platform: string): string {
  return (
    {
      bluesky: "🦋",
      devto: "📝",
      facebook: "ⓕ",
      facebook_en: "ⓕ",
      facebook_ru: "ⓕ",
      github: "🐙",
      github_en: "🐙",
      github_ru: "🐙",
      instagram: "📸",
      mastodon: "🐘",
      telegram: "✈️",
      threads: "@",
      threads_en: "@",
      threads_ru: "@",
      x: "𝕏",
      youtube: "▶️",
    }[platform] ?? "•"
  );
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
