import { metricNumber } from "../../../analytics/snapshots/creator-store.js";
import { videoDestinations } from "../../../channels/destinations.js";
import type { BackendDb } from "../../../db/client.js";
import { creatorProfiles } from "../../../db/schema.js";
import { zonedDateParts, zonedSlot } from "../../../foundation/time.js";
import {
  VIDEO_TARGETS,
  type VideoDestination,
  type VideoLocale,
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
  /** Views gained during the selected period, not the current lifetime total. */
  views: number;
  reactions: number;
  replies: number;
  /** Current lifetime views which arrived after the selected period ended. */
  afterPeriodViews: number;
  lifetimeViews: number;
};

/**
 * One row of the platform panel: a destination, not a platform.
 *
 * `locale` is declared by the channel registry rather than inferred from the
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

export type VideoSummaryMetrics = {
  /** A provider-native completion percentage, when a collector supplies one. */
  completionRate: number | null;
  /** Weighted average watch duration across the available video sources. */
  averageWatchTimeMs: number | null;
  /** Net subscribers/follows attributed to the selected video period. */
  subscribers: number | null;
};

export type VideoOverview = {
  items: VideoContentItem[];
  totals: { views: number; reactions: number; replies: number; posts: number };
  summary: VideoSummaryMetrics;
  platforms: VideoPlatformTotal[];
  /** Period increments keyed by the studio calendar date. */
  dailyByDay: Record<string, { views: number; reactions: number; replies: number }>;
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
};

type VideoMetrics = {
  views: number;
  likes: number;
  comments: number;
  averageWatchTimeMs: number | null;
  totalWatchTimeMs: number | null;
  follows: number | null;
  completionRate: number | null;
  videoDurationMs: number | null;
};
type VideoSnapshot = { at: Date; metrics: VideoMetrics };
type DailyMetrics = { views: number; reactions: number; replies: number };
type PeriodDay = { key: string; start: Date; end: Date };

export function emptyVideoOverview(): VideoOverview {
  return {
    items: [],
    totals: { views: 0, reactions: 0, replies: 0, posts: 0 },
    summary: { completionRate: null, averageWatchTimeMs: null, subscribers: null },
    platforms: [],
    dailyByDay: {},
    viewEvents: [],
  };
}

export function videoOverview(backendDb: BackendDb, start: Date, end: Date, timeZone = "Europe/Moscow"): VideoOverview {
  const catalogue = videoDestinations(backendDb);
  const rows = publishedTargets(backendDb, start.toISOString(), end.toISOString());
  const snapshots = videoSnapshots(backendDb, rows);
  const periodDays = calendarDays(start, end, timeZone);
  const summary = videoSummaryMetrics(backendDb, rows, snapshots, periodDays, end);
  const historicalDestinations = publishedDestinationKeys(backendDb, catalogue);
  const items = rows
    .map((row) => {
      const history = snapshots.get(row.id) ?? [];
      const period = periodMetrics(history, periodDays);
      const periodEnd = latestAtOrBefore(history, end)?.metrics ?? emptyMetrics();
      const lifetime = history.at(-1)?.metrics ?? emptyMetrics();
      const destination = destinationFor(catalogue, row);
      return {
        key: `video:${row.id}`,
        target: row.target,
        providerAccountId: row.providerAccountId,
        label: destination?.label ?? videoLabel(row.target),
        locale: destination ? destination.locale.toUpperCase() : (row.locale?.toUpperCase() ?? null),
        title: row.label || "Без названия",
        url: row.externalUrl,
        publishedAt: row.publishedAt,
        views: period.totals.views,
        reactions: period.totals.reactions,
        replies: period.totals.replies,
        afterPeriodViews: Math.max(0, lifetime.views - periodEnd.views),
        lifetimeViews: lifetime.views,
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
  const counted = catalogue.map((destination) => {
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
      followers: own,
      active: hasPublication || own !== null,
    }))
    .filter((row) => row.active)
    .map(({ active: _active, ...row }) => row);

  return {
    items,
    totals,
    summary,
    platforms,
    dailyByDay: aggregateDailyMetrics(rows, snapshots, periodDays),
    viewEvents: viewEvents(rows, snapshots, start, end),
  };
}

function publishedTargets(backendDb: BackendDb, startIso: string, endIso: string): TargetRow[] {
  return backendDb.sqlite
    .prepare(
      `SELECT t.id AS id, t.target AS target, COALESCE(d.label, '') AS label, d.locale AS locale, t.published_at AS publishedAt,
              t.provider_account_id AS providerAccountId, t.external_url AS externalUrl
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
        WHERE t.status = 'published' AND t.published_at IS NOT NULL AND t.published_at >= ? AND t.published_at <= ?
        ORDER BY t.published_at DESC`,
    )
    .all(startIso, endIso) as TargetRow[];
}

function videoSnapshots(backendDb: BackendDb, rows: TargetRow[]): Map<number, VideoSnapshot[]> {
  const snapshots = new Map<number, VideoSnapshot[]>();
  if (!rows.length) return snapshots;
  const placeholders = rows.map(() => "?").join(",");
  const samples = backendDb.sqlite
    .prepare(
      `SELECT video_target_id AS targetId, metrics_json AS metricsJson, sampled_at AS sampledAt
         FROM video_metric_snapshots
        WHERE video_target_id IN (${placeholders})
        ORDER BY video_target_id ASC, sampled_at ASC, id ASC`,
    )
    .all(...rows.map((row) => row.id)) as Array<{ targetId: number; metricsJson: string; sampledAt: string }>;
  for (const sample of samples) {
    const at = new Date(sample.sampledAt);
    if (Number.isNaN(at.getTime())) continue;
    const list = snapshots.get(sample.targetId) ?? [];
    list.push({ at, metrics: parseMetrics(sample.metricsJson) });
    snapshots.set(sample.targetId, list);
  }
  return snapshots;
}

function publishedDestinationKeys(backendDb: BackendDb, catalogue: readonly VideoDestination[]): Set<string> {
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
      .map((row) => destinationFor(catalogue, row))
      .filter((destination): destination is VideoDestination => destination !== null)
      .map(destinationKey),
  );
}

/** Samples for the clips of this period, converted to cumulative period deltas. */
function viewEvents(rows: TargetRow[], snapshots: Map<number, VideoSnapshot[]>, start: Date, end: Date): MetricEvent[] {
  if (!rows.length) return [];
  return rows
    .flatMap((row) => {
      const history = snapshots.get(row.id) ?? [];
      const baseline = latestAtOrBefore(history, start)?.metrics.views ?? 0;
      return history
        .filter((sample) => sample.at >= start && sample.at <= end)
        .map((sample) => ({ at: sample.at, key: `video:${row.id}`, value: Math.max(0, sample.metrics.views - baseline) }));
    })
    .sort((left, right) => left.at.getTime() - right.at.getTime());
}

function aggregateDailyMetrics(
  rows: TargetRow[],
  snapshots: Map<number, VideoSnapshot[]>,
  days: PeriodDay[],
): Record<string, DailyMetrics> {
  const result: Record<string, DailyMetrics> = {};
  for (const day of days) result[day.key] = emptyDailyMetrics();
  for (const row of rows) {
    const history = snapshots.get(row.id) ?? [];
    for (const day of days) {
      const before = latestAtOrBefore(history, day.start)?.metrics ?? emptyMetrics();
      const atEnd = latestAtOrBefore(history, day.end)?.metrics ?? before;
      const bucket = result[day.key] ?? emptyDailyMetrics();
      bucket.views += Math.max(0, atEnd.views - before.views);
      bucket.reactions += Math.max(0, atEnd.likes - before.likes);
      bucket.replies += Math.max(0, atEnd.comments - before.comments);
      result[day.key] = bucket;
    }
  }
  return result;
}

function periodMetrics(history: VideoSnapshot[], days: PeriodDay[]): { totals: DailyMetrics } {
  const totals = emptyDailyMetrics();
  for (const day of days) {
    const before = latestAtOrBefore(history, day.start)?.metrics ?? emptyMetrics();
    const atEnd = latestAtOrBefore(history, day.end)?.metrics ?? before;
    totals.views += Math.max(0, atEnd.views - before.views);
    totals.reactions += Math.max(0, atEnd.likes - before.likes);
    totals.replies += Math.max(0, atEnd.comments - before.comments);
  }
  return { totals };
}

function latestAtOrBefore(history: VideoSnapshot[], cutoff: Date): VideoSnapshot | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const sample = history[index];
    if (sample && sample.at <= cutoff) return sample;
  }
  return undefined;
}

function calendarDays(start: Date, end: Date, timeZone: string): PeriodDay[] {
  if (end < start) return [];
  const days: PeriodDay[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const parts = zonedDateParts(cursor, timeZone);
    const nextDay = zonedSlot(parts.year, parts.month, parts.day + 1, "00:00", timeZone);
    const dayEnd = new Date(Math.min(end.getTime(), nextDay.getTime() - 1));
    days.push({ key: calendarKey(cursor, timeZone), start: new Date(cursor), end: dayEnd });
    if (dayEnd >= end) break;
    cursor = nextDay;
  }
  return days;
}

function calendarKey(value: Date, timeZone: string): string {
  const parts = zonedDateParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function emptyMetrics(): VideoMetrics {
  return {
    views: 0,
    likes: 0,
    comments: 0,
    averageWatchTimeMs: null,
    totalWatchTimeMs: null,
    follows: null,
    completionRate: null,
    videoDurationMs: null,
  };
}

function emptyDailyMetrics(): DailyMetrics {
  return { views: 0, reactions: 0, replies: 0 };
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

function destinationFor(catalogue: readonly VideoDestination[], row: { target: string; locale: string | null }): VideoDestination | null {
  const locale = videoLocale(row.locale);
  return locale ? videoDestination(catalogue, row.target, locale) : null;
}

function destinationKey(destination: VideoDestination): string {
  return `${destination.target}:${destination.locale}`;
}

function videoLocale(value: string | null): VideoLocale | null {
  return value === "ru" || value === "en" ? value : null;
}

function parseMetrics(value: string | null): VideoMetrics {
  const metrics = parseJson(value);
  return {
    views: metricNumber(metrics.views),
    likes: metricNumber(metrics.likes),
    comments: metricNumber(metrics.comments),
    averageWatchTimeMs: optionalMetric(metrics.averageWatchTimeMs ?? metrics.averageWatchTime),
    totalWatchTimeMs: optionalMetric(metrics.totalWatchTimeMs ?? metrics.totalWatchTime),
    follows: optionalMetric(metrics.follows ?? metrics.subscribersGained),
    completionRate: optionalMetric(
      metrics.completionRate ?? metrics.completion_rate ?? metrics.completionPercentage ?? metrics.completion_percentage,
    ),
    videoDurationMs: optionalMetric(metrics.videoDurationMs ?? metrics.durationMs),
  };
}

function videoSummaryMetrics(
  backendDb: BackendDb,
  rows: TargetRow[],
  snapshots: Map<number, VideoSnapshot[]>,
  periodDays: PeriodDay[],
  end: Date,
): VideoSummaryMetrics {
  const watchSamples: Array<{ value: number; weight: number }> = [];
  const completionSamples: Array<{ value: number; weight: number }> = [];
  let subscribers = 0;
  let hasSubscribers = false;

  for (const row of rows) {
    const history = snapshots.get(row.id) ?? [];
    const latest = latestAtOrBefore(history, end)?.metrics;
    if (!latest) continue;
    const weight = Math.max(1, periodMetrics(history, periodDays).totals.views || latest.views);
    if (latest.averageWatchTimeMs !== null && latest.averageWatchTimeMs > 0)
      watchSamples.push({ value: latest.averageWatchTimeMs, weight });
    if (latest.completionRate !== null && latest.completionRate >= 0) completionSamples.push({ value: latest.completionRate, weight });
    if (latest.follows !== null) {
      subscribers += latest.follows;
      hasSubscribers = true;
    }
    if (latest.totalWatchTimeMs !== null && latest.videoDurationMs !== null && latest.views > 0 && latest.videoDurationMs > 0) {
      completionSamples.push({
        value: Math.min(100, (latest.totalWatchTimeMs / (latest.views * latest.videoDurationMs)) * 100),
        weight,
      });
    }
  }

  // YouTube Analytics stores account-level retention and subscriber deltas in
  // creator profiles. Historical dashboard windows must not silently reuse
  // today's profile values.
  if (end.getTime() >= Date.now() - 2 * 86_400_000) {
    const profileMetrics = youtubeProfileMetrics(backendDb, periodDays.length);
    if (profileMetrics.averageWatchTimeMs !== null)
      watchSamples.push({ value: profileMetrics.averageWatchTimeMs, weight: Math.max(1, profileMetrics.views) });
    if (profileMetrics.subscribers !== null) {
      subscribers += profileMetrics.subscribers;
      hasSubscribers = true;
    }
  }

  return {
    completionRate: weightedAverage(completionSamples),
    averageWatchTimeMs: weightedAverage(watchSamples),
    subscribers: hasSubscribers ? subscribers : null,
  };
}

function youtubeProfileMetrics(
  backendDb: BackendDb,
  days: number,
): { averageWatchTimeMs: number | null; subscribers: number | null; views: number } {
  const suffix = days === 30 ? "" : `${days}d`;
  let averageWatchTotal = 0;
  let averageWatchWeight = 0;
  let subscribers = 0;
  let hasSubscribers = false;
  let views = 0;
  for (const profile of backendDb.db.select().from(creatorProfiles).all()) {
    if (!profile.platform.startsWith("youtube")) continue;
    const data = profile.dataJson as Record<string, unknown>;
    const periodViews = optionalMetric(data[`views${suffix}`] ?? data.views ?? data.viewCount) ?? 0;
    const averageViewDuration = optionalMetric(data[`averageViewDuration${suffix}`] ?? data.averageViewDuration);
    if (averageViewDuration !== null && averageViewDuration > 0) {
      const weight = Math.max(1, periodViews);
      averageWatchTotal += averageViewDuration * 1_000 * weight;
      averageWatchWeight += weight;
    }
    const gained = optionalMetric(data[`subscribersGained${suffix}`] ?? data.subscribersGained);
    const lost = optionalMetric(data[`subscribersLost${suffix}`] ?? data.subscribersLost);
    if (gained !== null || lost !== null) {
      subscribers += (gained ?? 0) - (lost ?? 0);
      hasSubscribers = true;
    }
    views += periodViews;
  }
  return {
    averageWatchTimeMs: averageWatchWeight > 0 ? averageWatchTotal / averageWatchWeight : null,
    subscribers: hasSubscribers ? subscribers : null,
    views,
  };
}

function optionalMetric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function weightedAverage(samples: Array<{ value: number; weight: number }>): number | null {
  if (!samples.length) return null;
  const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  return weight > 0 ? samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / weight : null;
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
