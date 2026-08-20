import { eq } from "drizzle-orm";
import { channelIdentity } from "../../channels/identity.js";
import { listChannels } from "../../channels/registry.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { creatorProfiles, socialComments } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { latestVideoMetrics, siteTotal, sum, textTotals, type VideoMetricRow } from "../metric-deltas.js";
import { metricNumber } from "../snapshots/creator-store.js";

export function creatorDashboard(
  backendDb: BackendDb,
  config: BackendConfig,
  days: number,
  locale: StudioLocale = "ru",
): { text: string; hasComments: boolean } {
  const hasComments = unsafeDb(backendDb).db.select({ id: socialComments.commentId }).from(socialComments).limit(1).get() != null;
  if (days === 0) return overallDashboard(backendDb, config, hasComments, locale);
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const latest = latestVideoMetrics(backendDb, since);
  const period = days === 1 ? t(locale, "report.period-today") : t(locale, "report.period-days", { days });
  const lines = [`📊 *${t(locale, "report.stats-for", { period })}*`];
  if (config.studio.siteEnabled)
    lines.push(`🌐 ${t(locale, "report.site")}: ${siteTotal(backendDb, since)} ${t(locale, "report.material-views")}`);
  const text = textTotals(backendDb, since);
  lines.push(
    `📝 ${t(locale, "report.posts")}: ${text.views} ${t(locale, "report.views")} · ${text.interactions} ${t(locale, "report.interactions-lc")}`,
  );
  appendVideoDashboard(lines, latest, backendDb, locale);
  lines.push(`\n${t(locale, "report.data-refresh")}`);
  return { text: lines.join("\n"), hasComments };
}

function overallDashboard(
  backendDb: BackendDb,
  config: BackendConfig,
  hasComments: boolean,
  locale: StudioLocale,
): { text: string; hasComments: boolean } {
  const connectedPlatforms = new Set(listChannels(backendDb).map((channel) => channel.platform));
  const lines = [`🌐 *${t(locale, "report.overall-stats")}*`];
  if (config.studio.siteEnabled)
    lines.push(
      `\n🌐 ${t(locale, "report.site")}: ${siteTotal(backendDb, "0000-01-01T00:00:00.000Z")} ${t(locale, "report.material-views")}`,
    );
  const overallText = textTotals(backendDb, "0000-01-01T00:00:00.000Z");
  lines.push(
    `📝 ${t(locale, "report.posts")}: ${overallText.views} ${t(locale, "report.views")} · ${overallText.interactions} ${t(locale, "report.interactions-lc")}`,
  );
  if (connectedPlatforms.has("youtube")) {
    const profileData = profile(backendDb, "youtube");
    lines.push(`\n${t(locale, "dash.youtube-channel")}`);
    if (!profileData) lines.push(t(locale, "dash.channel-not-synced"));
    else {
      const gained = metricNumber(profileData.subscribersGained);
      const lost = metricNumber(profileData.subscribersLost);
      lines.push(
        t(locale, "dash.subscribers-line", { n: metricNumber(profileData.subscriberCount) }),
        t(locale, "dash.lifetime-views", { n: metricNumber(profileData.viewCount) }),
        t(locale, "dash.total-videos", { n: metricNumber(profileData.videoCount) }),
        t(locale, "dash.last-30-days"),
        t(locale, "dash.views-sub", { n: metricNumber(profileData.views) }),
        t(locale, "dash.watch-time", { n: (metricNumber(profileData.estimatedMinutesWatched) / 60).toFixed(1) }),
        t(locale, "dash.subs-delta", { gained, lost, net: gained - lost }),
      );
    }
  }
  if (connectedPlatforms.has("instagram")) {
    const profileData = profile(backendDb, "instagram");
    lines.push(`\n${t(locale, "dash.instagram-profile")}`);
    if (!profileData) lines.push(t(locale, "dash.profile-not-synced"));
    else {
      lines.push(t(locale, "dash.followers-line", { n: metricNumber(profileData.followersCount) }));
      if (profileData.mediaCount != null) lines.push(t(locale, "dash.total-reels", { n: metricNumber(profileData.mediaCount) }));
      if (profileData.reach30d != null)
        lines.push(
          t(locale, "dash.ig-30d", {
            reach: metricNumber(profileData.reach30d),
            views: metricNumber(profileData.views30d),
            interactions: metricNumber(profileData.interactions30d),
            saves: metricNumber(profileData.saves30d),
            shares: metricNumber(profileData.shares30d),
            reposts: metricNumber(profileData.reposts30d),
          }),
        );
    }
  }
  lines.push(`\n${t(locale, "report.data-refresh")}`);
  return { text: lines.join("\n"), hasComments };
}

function appendVideoDashboard(lines: string[], latest: VideoMetricRow[], backendDb: BackendDb, locale: StudioLocale): void {
  const connectedPlatforms = new Set(listChannels(backendDb).map((channel) => channel.platform));
  const youtube = latest.filter((row) => row.platform === "youtube_shorts");
  const instagram = latest.filter((row) => row.platform === "instagram_reels");
  const all = [...youtube, ...instagram];
  lines.push(
    `🎬 ${t(locale, "report.videos")}: ${sum(all, "views")} ${t(locale, "report.views")} · ${sum(all, "likes") + sum(all, "comments")} ${t(locale, "report.interactions-lc")}`,
  );
  if (connectedPlatforms.has("youtube")) {
    const data = profile(backendDb, "youtube");
    lines.push(
      `${t(locale, "dash.yt-summary", { views: sum(youtube, "views"), likes: sum(youtube, "likes") })}${data ? t(locale, "dash.subs-suffix", { n: metricNumber(data.subscriberCount) }) : ""}`,
    );
  }
  if (connectedPlatforms.has("instagram")) {
    const data = profile(backendDb, "instagram");
    lines.push(
      `${t(locale, "dash.ig-summary", { views: sum(instagram, "views"), likes: sum(instagram, "likes"), comments: sum(instagram, "comments") })}${data ? t(locale, "dash.followers-suffix", { n: metricNumber(data.followersCount) }) : ""}`,
    );
  }
  const grouped: Record<string, { views: number; likes: number; comments: number }> = {};
  for (const row of latest) {
    const label = row.label || t(locale, "common.untitled");
    const item = grouped[label] ?? { views: 0, likes: 0, comments: 0 };
    item.views += metricNumber(row.metrics.views);
    item.likes += metricNumber(row.metrics.likes);
    item.comments += metricNumber(row.metrics.comments);
    grouped[label] = item;
  }
  const top = Object.entries(grouped)
    .map(([label, metrics]) => ({ label, ...metrics }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 3);
  if (top.length) {
    lines.push(`\n${t(locale, "dash.top-publications")}`);
    for (const item of top)
      lines.push(
        t(locale, "dash.top-item", { label: item.label, views: metricNumber(item.views), likes: item.likes, comments: item.comments }),
      );
  }
}

/** The metric fields this report reads out of a creator profile snapshot. Every
 * one is optional and passes through `metricNumber`, so a snapshot written by an
 * older collector renders as zeroes rather than `undefined` or a crash. */
type CreatorProfileMetrics = {
  subscriberCount?: unknown;
  viewCount?: unknown;
  videoCount?: unknown;
  views?: unknown;
  estimatedMinutesWatched?: unknown;
  subscribersGained?: unknown;
  subscribersLost?: unknown;
  followersCount?: unknown;
  mediaCount?: unknown;
  reach30d?: unknown;
  views30d?: unknown;
  interactions30d?: unknown;
  saves30d?: unknown;
  shares30d?: unknown;
  reposts30d?: unknown;
};

function profile(backendDb: BackendDb, platform: string): CreatorProfileMetrics | null {
  const profiles = (["ru", "en"] as const)
    .map(
      (locale) =>
        unsafeDb(backendDb)
          .db.select()
          .from(creatorProfiles)
          .where(eq(creatorProfiles.platform, channelIdentity(platform, locale)))
          .get()?.dataJson,
    )
    .filter((data): data is Record<string, unknown> => data != null && typeof data === "object" && !Array.isArray(data));
  if (!profiles.length) return null;

  const numericFields: Array<keyof CreatorProfileMetrics> = [
    "subscriberCount",
    "viewCount",
    "videoCount",
    "views",
    "estimatedMinutesWatched",
    "subscribersGained",
    "subscribersLost",
    "followersCount",
    "mediaCount",
    "reach30d",
    "views30d",
    "interactions30d",
    "saves30d",
    "shares30d",
    "reposts30d",
  ];
  const total: CreatorProfileMetrics = {};
  for (const data of profiles)
    for (const field of numericFields) if (data[field] != null) total[field] = metricNumber(total[field]) + metricNumber(data[field]);
  return total;
}
