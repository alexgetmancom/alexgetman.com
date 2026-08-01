import { metricNumber } from "../../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../../db/client.js";
import {
  legacyVideoProfile,
  VIDEO_DESTINATIONS,
  VIDEO_TARGETS,
  type VideoDestination,
  type VideoLocale,
  type VideoTarget,
  videoDestination,
  videoTargetLabel,
} from "../../../publishing/video-types.js";

/**
 * Read model behind the video half of the unified overview.
 *
 * The Video tab reads the same tables per draft, one row per (draft, target).
 * This module answers a different question — "what did video do in this
 * period" — in the vocabulary the text side already speaks: totals, per
 * platform figures, content rows, and raw view samples for the chart. Keeping
 * that translation here is what lets combined-section.ts stay unaware of
 * video_targets and of the fact that a video "reaction" is a like and a video
 * "reply" is a comment.
 */

/** One published video on one platform. The unit is the publication, not the
 * draft: the same clip on YouTube and on Reels is two rows, exactly as one post
 * on Threads and on Telegram is two publications on the text side. */
export type VideoContentItem = {
  key: string;
  target: string;
  providerAccountId: string | null;
  label: string;
  locale: string | null;
  title: string;
  url: string | null;
  publishedAt: string | null;
  views: number;
  reactions: number;
  replies: number;
};

/**
 * One row of the platform panel: a destination, not a platform.
 *
 * `locale` is declared by VIDEO_DESTINATIONS rather than inferred from the
 * clips of this period — a Russian channel is Russian on a week it published
 * nothing — and `followers` come from that destination's own profile key, so
 * the RU and EN channels stop sharing one legacy count.
 */
export type VideoPlatformTotal = {
  target: string;
  label: string;
  locales: string[];
  views: number;
  followers: number | null;
};

/** A raw metric observation, before it is folded into a cumulative curve. */
export type MetricEvent = { at: Date; key: string; value: number };

export type VideoOverview = {
  items: VideoContentItem[];
  totals: { views: number; reactions: number; replies: number; posts: number };
  platforms: VideoPlatformTotal[];
  viewEvents: MetricEvent[];
};

type TargetRow = {
  id: number;
  target: string;
  providerAccountId: string | null;
  label: string;
  locale: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  metricsJson: string | null;
};

export function emptyVideoOverview(): VideoOverview {
  return { items: [], totals: { views: 0, reactions: 0, replies: 0, posts: 0 }, platforms: [], viewEvents: [] };
}

/**
 * The pre-split `youtube` / `instagram` snapshot, when it can be attributed to
 * exactly one channel.
 *
 * A Studio that never split its profiles has one live destination per target;
 * the legacy count is that channel's, and dropping it would blank a number the
 * dashboard used to show. As soon as any locale-scoped snapshot exists for the
 * target, or a second language is publishing, the legacy row is ambiguous and
 * is not used — showing it on both rows would count the same audience twice.
 */
function legacyFollowers(
  target: string,
  counted: Array<{ destination: VideoDestination; published: VideoContentItem[]; hasPublication: boolean; own: number | null }>,
  followers: Map<string, number>,
): number | null {
  const siblings = counted.filter((entry) => entry.destination.target === target);
  if (siblings.some((entry) => entry.own !== null)) return null;
  if (siblings.filter((entry) => entry.hasPublication).length !== 1) return null;
  return followers.get(legacyVideoProfile(target as VideoTarget)) ?? null;
}

export function videoOverview(backendDb: BackendDb, start: Date, end: Date): VideoOverview {
  const rows = publishedTargets(backendDb, start.toISOString(), end.toISOString());
  const historicalDestinations = publishedDestinationKeys(backendDb);
  const items = rows
    .map((row) => {
      const metrics = parseMetrics(row.metricsJson);
      const destination = destinationFor(row);
      return {
        key: `video:${row.id}`,
        target: row.target,
        providerAccountId: row.providerAccountId,
        label: destination?.label ?? videoLabel(row.target),
        locale: destination ? destination.locale.toUpperCase() : (row.locale?.toUpperCase() ?? null),
        title: row.label || "Без названия",
        url: row.externalUrl,
        publishedAt: row.publishedAt,
        views: metrics.views,
        reactions: metrics.likes,
        replies: metrics.comments,
      };
    })
    .sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""));

  const totals = items.reduce(
    (all, item) => {
      all.views += item.views;
      all.reactions += item.reactions;
      all.replies += item.replies;
      all.posts += 1;
      return all;
    },
    { views: 0, reactions: 0, replies: 0, posts: 0 },
  );

  const followers = followerCounts(backendDb);
  // One row per declared destination, filtered to the ones this Studio actually
  // has: publications in the period, or an audience snapshot. Listing the whole
  // catalogue would put an English channel on a Studio that has never had one;
  // listing only what published would drop a real channel on a quiet week.
  const counted = VIDEO_DESTINATIONS.map((destination) => {
    const published = items.filter((item) => item.target === destination.target && item.locale === destination.locale.toUpperCase());
    return {
      destination,
      published,
      hasPublication: historicalDestinations.has(destinationKey(destination)),
      own: followers.get(destination.profile) ?? null,
    };
  });
  const platforms = counted
    .map(({ destination, published, hasPublication, own }) => ({
      target: destination.target as string,
      label: destination.label,
      locales: [destination.locale.toUpperCase()],
      views: published.reduce((sum, item) => sum + item.views, 0),
      followers: own ?? legacyFollowers(destination.target, counted, followers),
      active: hasPublication || own !== null,
    }))
    .filter((row) => row.active)
    .map(({ active: _active, ...row }) => row);

  return { items, totals, platforms, viewEvents: viewEvents(backendDb, rows, start, end) };
}

function publishedTargets(backendDb: BackendDb, startIso: string, endIso: string): TargetRow[] {
  return backendDb.sqlite
    .prepare(
      `SELECT t.id AS id, t.target AS target, COALESCE(d.label, '') AS label, d.locale AS locale, t.published_at AS publishedAt,
              t.provider_account_id AS providerAccountId, t.external_url AS externalUrl, s.metrics_json AS metricsJson
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
         LEFT JOIN video_metric_snapshots s
                ON s.id = (SELECT id FROM video_metric_snapshots WHERE video_target_id = t.id ORDER BY sampled_at DESC, id DESC LIMIT 1)
        WHERE t.status = 'published' AND t.published_at IS NOT NULL AND t.published_at >= ? AND t.published_at <= ?
        ORDER BY t.published_at DESC`,
    )
    .all(startIso, endIso) as TargetRow[];
}

function publishedDestinationKeys(backendDb: BackendDb): Set<string> {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT t.target AS target, d.locale AS locale
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
        WHERE t.status = 'published'`,
    )
    .all() as Array<{ target: string; locale: string | null }>;
  return new Set(
    rows
      .map(destinationFor)
      .filter((destination): destination is VideoDestination => destination !== null)
      .map(destinationKey),
  );
}

/** Samples for the clips of this period, inside this period. Mirrors the text
 * side, where the daily chart plots the posts the period selected. */
function viewEvents(backendDb: BackendDb, rows: TargetRow[], start: Date, end: Date): MetricEvent[] {
  if (!rows.length) return [];
  const placeholders = rows.map(() => "?").join(",");
  const samples = backendDb.sqlite
    .prepare(
      `SELECT video_target_id AS targetId, metrics_json AS metricsJson, sampled_at AS sampledAt
         FROM video_metric_snapshots
        WHERE video_target_id IN (${placeholders}) AND sampled_at >= ? AND sampled_at <= ?
        ORDER BY sampled_at ASC, id ASC`,
    )
    .all(...rows.map((row) => row.id), start.toISOString(), end.toISOString()) as Array<{
    targetId: number;
    metricsJson: string;
    sampledAt: string;
  }>;
  return samples
    .map((sample) => ({
      at: new Date(sample.sampledAt),
      key: `video:${sample.targetId}`,
      value: parseMetrics(sample.metricsJson).views,
    }))
    .filter((event) => !Number.isNaN(event.at.getTime()));
}

function followerCounts(backendDb: BackendDb): Map<string, number> {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT platform, metrics_json AS metricsJson FROM creator_profile_snapshots
        WHERE id IN (SELECT MAX(id) FROM creator_profile_snapshots GROUP BY platform, account)`,
    )
    .all() as Array<{ platform: string; metricsJson: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const metrics = parseJson(row.metricsJson);
    const value = metricNumber(metrics.subscriberCount ?? metrics.followersCount);
    // Snapshots exist per (platform, account); the overview panel is per
    // platform, so the accounts publishing through one platform are summed.
    counts.set(row.platform, (counts.get(row.platform) ?? 0) + value);
  }
  return counts;
}

function destinationFor(row: { target: string; locale: string | null }): VideoDestination | null {
  const locale = videoLocale(row.locale);
  return locale ? videoDestination(row.target, locale) : null;
}

function destinationKey(destination: VideoDestination): string {
  return `${destination.target}:${destination.locale}`;
}

function videoLocale(value: string | null): VideoLocale | null {
  return value === "ru" || value === "en" ? value : null;
}

function parseMetrics(value: string | null): { views: number; likes: number; comments: number } {
  const metrics = parseJson(value);
  return { views: metricNumber(metrics.views), likes: metricNumber(metrics.likes), comments: metricNumber(metrics.comments) };
}

function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function videoLabel(target: string): string {
  const known = VIDEO_TARGETS.find((candidate) => candidate === target);
  return known ? videoTargetLabel(known) : target;
}
