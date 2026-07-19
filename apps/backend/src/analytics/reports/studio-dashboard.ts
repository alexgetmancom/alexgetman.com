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
  youtubeChannelViewDeltaSince,
} from "../metric-deltas.js";
import { metricNumber } from "../snapshots/creator-store.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";
type AnalyticsPeriod = 1 | 7 | 30;

type StudioAnalyticsDashboard = {
  text: string;
  richHtml: string;
  hasComments: boolean;
};

/** A dashboard is built once as a list of blocks and rendered twice — as plain
 * text (Markdown-flavored tables, for MCP/web) and as Telegram Rich Message
 * HTML. Building the structure once avoids re-parsing the text form to
 * produce the HTML form. */
type Block = { kind: "text"; text: string } | { kind: "table"; headers: string[]; rows: string[][] };

function textBlock(text: string): Block {
  return { kind: "text", text };
}

function tableBlock(headers: string[], rows: string[][]): Block {
  return { kind: "table", headers, rows };
}

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
  const blocks: Block[] = [];

  if (section === "audience") {
    blocks.push(textBlock(`👥 *${t(locale, "sdash.header-audience", { period })}*`));
    const profiles = audienceProfiles(backendDb, config, since, days, period, locale);
    blocks.push(...(profiles.length ? profiles : [textBlock(t(locale, "sdash.no-audience"))]));
  } else {
    blocks.push(...unifiedAnalyticsTable(backendDb, config, section, since, days, locale));
  }
  return { text: blocksToText(blocks), richHtml: blocksToHtml(blocks), hasComments: hasAudienceComments(backendDb) };
}

function blocksToText(blocks: Block[]): string {
  return blocks.map((block) => (block.kind === "table" ? tableText(block) : block.text)).join("\n");
}

function tableText(block: Extract<Block, { kind: "table" }>): string {
  const divider = `|${block.headers.map((_, index) => (index === 0 ? ":--" : "--:")).join("|")}|`;
  return [pipeLine(block.headers), divider, ...block.rows.map(pipeLine)].join("\n");
}

function pipeLine(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** Telegram's new rich-message Markdown deliberately has no table syntax.
 * Use its supported HTML <table> block instead of sending pipe characters as
 * visible text. */
function blocksToHtml(blocks: Block[]): string {
  return blocks
    .filter((block) => block.kind === "table" || block.text)
    .map((block) => (block.kind === "table" ? tableHtml(block) : `<p>${richInlineHtml(block.text)}</p>`))
    .join("\n");
}

function tableHtml(block: Extract<Block, { kind: "table" }>): string {
  const headerRow = `<tr>${block.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>`;
  const dataRows = block.rows
    .map((row) => `<tr>${row.map((cell, index) => `<td align="${index ? "right" : "left"}">${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table bordered striped>${headerRow}${dataRows}</table>`;
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
): Block[] {
  const growth = audienceGrowthByPlatform(backendDb, since, days);
  return backendDb.db
    .select()
    .from(creatorProfiles)
    .all()
    .filter((row) => enabledAudiencePlatforms(config).has(row.platform))
    .sort((left, right) => {
      const rightFollowers = metricNumber(right.dataJson.subscriberCount ?? right.dataJson.followersCount);
      const leftFollowers = metricNumber(left.dataJson.subscriberCount ?? left.dataJson.followersCount);
      return rightFollowers - leftFollowers || platformLabel(left.platform).localeCompare(platformLabel(right.platform));
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
      return textBlock(`• *${platformLabel(row.platform)}* — ${values.join(" · ")}`);
    });
}

function unifiedAnalyticsTable(
  backendDb: BackendDb,
  config: BackendConfig,
  section: Exclude<AnalyticsSection, "audience">,
  since: string,
  days: AnalyticsPeriod,
  locale: BotLocale,
): Block[] {
  const profiles = backendDb.db
    .select()
    .from(creatorProfiles)
    .all()
    .filter((row) => audiencePlatformsForSection(config, section).has(row.platform));
  const accountMetrics = new Map(profiles.map((row) => [row.platform, contentMetricsFromProfile(row.dataJson, days)]));
  const content = accountContentMetricsForSection(backendDb, config, section, since, accountMetrics);
  if (days === 1 && section !== "posts" && config.studio.modules.youtube) {
    const liveViews = youtubeChannelViewDeltaSince(backendDb, since);
    const youtube = content.get("youtube");
    const tracked = sumContentMetrics(
      latestVideoMetrics(backendDb, since)
        .filter((row) => row.platform === "youtube_shorts")
        .map((row) => contentMetrics(row)),
    );
    // Until Analytics closes today's report, retain its delayed engagement
    // fields but replace the misleading zero channel-view total with the live
    // delta. A missing hourly baseline leaves the existing value untouched.
    if (youtube && youtube.views === 0)
      content.set("youtube", {
        ...youtube,
        views: liveViews ?? tracked.views,
        likes: tracked.likes,
        comments: tracked.comments,
        shares: tracked.shares,
        saves: tracked.saves,
      });
  }
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
      // A missing baseline is unknown, not zero growth. This is common during
      // the first week after connecting a Zernio account.
      growth: profileMap.has(platform) ? (growth.get(platform) ?? null) : null,
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
  const all = locale === "ru" ? "Все" : "All";
  const headers = [locale === "ru" ? "Площадка" : "Platform", "👥", "📈", "👁", "♥", "💬", "↗", "🔖"];
  const tableRows = [
    { platform: "all", label: `📊 ${all}`, growth: totalGrowth, value: totalContent },
    ...rows.map((row) => ({ label: `${platformIcon(row.platform)} ${platformLabel(row.platform)}`, ...row })),
  ].map((row) => [
    row.label,
    String(row.platform === "all" ? totalFollowers : followerCount(profileMap.get(row.platform)?.dataJson)),
    row.growth == null ? "—" : signed(row.growth),
    String(row.value.views),
    String(row.value.likes),
    String(row.value.comments),
    dash(row.value.shares),
    row.platform === "youtube" ? "—" : dash(row.value.saves),
  ]);
  return [
    tableBlock(headers, tableRows),
    ...(section === "posts"
      ? publishedPostTable(backendDb, config, since, days, locale)
      : publishedVideoTable(backendDb, config, section, since, days, locale)),
  ];
}

function publishedPostTable(backendDb: BackendDb, config: BackendConfig, since: string, days: AnalyticsPeriod, locale: BotLocale): Block[] {
  if (!config.studio.modules.text_posting) return [];
  const rows = latestTextPostMetrics(backendDb, since).filter((row) => Object.keys(row.metrics).length > 0);
  if (!rows.length) return [];
  const values = rows.map(contentMetrics);
  const total = sumContentMetrics(values);
  const all = locale === "ru" ? "Все" : "All";
  const headers = [locale === "ru" ? "Пост" : "Post", "👁", "♥", "💬", "↗", "🔖"];
  const tableRows = [
    [all, String(total.views), String(total.likes), String(total.comments), dash(total.shares), dash(total.saves)],
    ...topDetails(rows, days).map((row) =>
      contentRowCells(`${shortLabel(row.label)} · ${platformIcon(row.platform)}`, contentMetrics(row)),
    ),
  ];
  return [tableBlock(headers, tableRows)];
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
  days: AnalyticsPeriod,
  locale: BotLocale,
): Block[] {
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
  const headers = [locale === "ru" ? "Видео" : "Video", "👁", "♥", "💬", "↗", "🔖"];
  const tableRows = [
    [all, String(total.views), String(total.likes), String(total.comments), dash(total.shares), dash(total.saves)],
    ...topDetails(rows, days).map((row) => {
      const platform = row.platform === "instagram_reels" ? "instagram" : "youtube";
      return contentRowCells(`${shortLabel(row.label)} · ${platformIcon(platform)}`, contentMetrics(row), platform === "youtube");
    }),
  ];
  return [tableBlock(headers, tableRows)];
}

function topDetails<T extends { metrics: Record<string, unknown> }>(rows: T[], days: AnalyticsPeriod): T[] {
  if (days === 1) return rows;
  return [...rows].sort((left, right) => metricNumber(right.metrics.views) - metricNumber(left.metrics.views)).slice(0, 10);
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

function contentRowCells(label: string, metrics: ContentMetrics, hidesSaves = false): string[] {
  return [
    label,
    String(metrics.views),
    String(metrics.likes),
    String(metrics.comments),
    dash(metrics.shares),
    hidesSaves ? "—" : dash(metrics.saves),
  ];
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

function followerCount(data: Record<string, unknown> | undefined): number {
  return metricNumber(data?.subscriberCount ?? data?.followersCount);
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
