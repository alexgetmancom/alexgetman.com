import { audienceGrowthByPlatform } from "../../../analytics/metric-deltas.js";
import { metricNumber } from "../../../analytics/snapshots/creator-store.js";
import { videoDestinations } from "../../../channels/destinations.js";
import { type BackendDb, unsafeDb } from "../../../db/client.js";
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
  /** Net subscribers/follows attributed to this publication during the period. */
  subscribers: number | null;
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
  dailyByDay: Record<string, DailyVideoMetrics>;
  viewEvents: MetricEvent[];
};

/** Request-scoped cache shared by the period comparisons on one dashboard. */
export type VideoOverviewCache = {
  rangeStart: Date | null;
  rangeEnd: Date | null;
  sampleBucketSeconds: number;
  bundleKey: string | null;
  bundle: VideoAnalyticsBundle | null;
  audienceGrowth: Map<string, Map<string, number>>;
  audienceGrowthByDay: Map<string, Map<string, Map<string, number>>>;
  profileSummaries: Map<string, ProfileSummaryMetrics>;
};

export function createVideoOverviewCache(sampleBucketSeconds = 60 * 60): VideoOverviewCache {
  return {
    rangeStart: null,
    rangeEnd: null,
    sampleBucketSeconds,
    bundleKey: null,
    bundle: null,
    audienceGrowth: new Map(),
    audienceGrowthByDay: new Map(),
    profileSummaries: new Map(),
  };
}

/** Sets the one bounded history window shared by all period comparisons in a render. */
export function setVideoOverviewCacheRange(cache: VideoOverviewCache, start: Date, end: Date, sampleBucketSeconds?: number): void {
  if (
    cache.rangeStart?.getTime() !== start.getTime() ||
    cache.rangeEnd?.getTime() !== end.getTime() ||
    (sampleBucketSeconds !== undefined && cache.sampleBucketSeconds !== sampleBucketSeconds)
  ) {
    cache.bundleKey = null;
    cache.bundle = null;
    cache.audienceGrowth.clear();
    cache.audienceGrowthByDay.clear();
    cache.profileSummaries.clear();
  }
  cache.rangeStart = start;
  cache.rangeEnd = end;
  if (sampleBucketSeconds !== undefined) cache.sampleBucketSeconds = sampleBucketSeconds;
}

export type TargetRow = {
  id: number;
  target: string;
  providerAccountId: string | null;
  label: string;
  locale: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  metadataJson: string | null;
};

export type VideoMetrics = {
  views: number;
  likes: number;
  comments: number;
  averageWatchTimeMs: number | null;
  totalWatchTimeMs: number | null;
  follows: number | null;
  completionRate: number | null;
  videoDurationMs: number | null;
};
export type VideoSnapshot = { at: Date; metrics: VideoMetrics };
export type DailyMetrics = { views: number; reactions: number; replies: number };
export type DailyVideoMetrics = DailyMetrics & { subscribers: number | null };
export type PeriodDay = { key: string; start: Date; end: Date };
export type VideoAnalyticsBundle = {
  catalogue: readonly VideoDestination[];
  rows: TargetRow[];
  snapshots: Map<number, VideoSnapshot[]>;
  historicalDestinations: Set<string>;
  followers: Map<string, number>;
};

const VIDEO_BUNDLE_TTL_MS = 3_000;
const MAX_SHARED_VIDEO_BUNDLES = 1;
export type SharedVideoBundle = { expiresAt: number; bundle: VideoAnalyticsBundle };
const sharedVideoBundles = new WeakMap<BackendDb, Map<string, SharedVideoBundle>>();

/** Drops the short-lived cross-request bundle after a dashboard mutation. */
export function invalidateVideoOverviewCache(backendDb: BackendDb): void {
  sharedVideoBundles.delete(backendDb);
}

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
export function videoAnalyticsBundle(backendDb: BackendDb, start: Date, end: Date, cache?: VideoOverviewCache): VideoAnalyticsBundle {
  const rangeStart = cache?.rangeStart ?? start;
  const rangeEnd = cache?.rangeEnd ?? end;
  const bucketSeconds = cache?.sampleBucketSeconds ?? (end.getTime() - start.getTime() > 7 * 86_400_000 ? 86_400 : 3_600);
  const key = `${rangeStart.toISOString()}|${rangeEnd.toISOString()}|${bucketSeconds}`;
  if (cache?.bundleKey === key && cache.bundle) return cache.bundle;

  const now = Date.now();
  const shared = sharedVideoBundles.get(backendDb);
  const sharedEntry = shared?.get(key);
  if (sharedEntry && sharedEntry.expiresAt > now) {
    if (cache) {
      cache.bundleKey = key;
      cache.bundle = sharedEntry.bundle;
    }
    return sharedEntry.bundle;
  }

  const catalogue = videoDestinations(backendDb);
  const rows = publishedTargets(backendDb, rangeStart.toISOString(), rangeEnd.toISOString());
  fillMissingVideoUrls(backendDb, rows);
  const snapshots = videoSnapshots(backendDb, rows, rangeStart, rangeEnd, bucketSeconds);
  const bundle: VideoAnalyticsBundle = {
    catalogue,
    rows,
    snapshots,
    historicalDestinations: publishedDestinationKeys(backendDb, catalogue),
    followers: followerCounts(backendDb),
  };

  const entries = shared ?? new Map<string, SharedVideoBundle>();
  entries.set(key, { expiresAt: now + VIDEO_BUNDLE_TTL_MS, bundle });
  while (entries.size > MAX_SHARED_VIDEO_BUNDLES) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== "string") break;
    entries.delete(oldest);
  }
  sharedVideoBundles.set(backendDb, entries);
  if (cache) {
    cache.bundleKey = key;
    cache.bundle = bundle;
  }
  return bundle;
}

export function publishedTargets(backendDb: BackendDb, startIso: string, endIso: string): TargetRow[] {
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT t.id AS id, t.target AS target, COALESCE(d.label, '') AS label, d.locale AS locale, t.published_at AS publishedAt,
              t.provider_account_id AS providerAccountId, t.external_url AS externalUrl, t.metadata_json AS metadataJson
         FROM video_targets t
         JOIN video_drafts d ON d.id = t.video_draft_id
        WHERE t.status = 'published' AND t.published_at IS NOT NULL AND t.published_at >= ? AND t.published_at <= ?
        ORDER BY t.published_at DESC`,
    )
    .all(startIso, endIso) as TargetRow[];
}

export function fillMissingVideoUrls(backendDb: BackendDb, rows: TargetRow[]): void {
  const missingIds = rows.filter((row) => !row.externalUrl).map((row) => row.id);
  if (!missingIds.length) return;
  const placeholders = missingIds.map(() => "?").join(",");
  const snapshots = unsafeDb(backendDb)
    .sqlite.prepare(
      `WITH candidates AS (
         SELECT video_target_id AS videoTargetId,
                json_extract(metrics_json, '$.url') AS url,
                ROW_NUMBER() OVER (
                  PARTITION BY video_target_id
                  ORDER BY sampled_at DESC, id DESC
                ) AS rowNumber
           FROM video_metric_snapshots
          WHERE video_target_id IN (${placeholders})
            AND json_type(metrics_json, '$.url') = 'text'
            AND (json_extract(metrics_json, '$.url') LIKE 'http://%' OR json_extract(metrics_json, '$.url') LIKE 'https://%')
       )
       SELECT videoTargetId, url
         FROM candidates
        WHERE rowNumber = 1`,
    )
    .all(...missingIds) as Array<{ videoTargetId: number; url: unknown }>;
  const urls = new Map<number, string>();
  for (const snapshot of snapshots) {
    if (urls.has(snapshot.videoTargetId)) continue;
    const url = snapshotUrl(snapshot.url);
    if (url) urls.set(snapshot.videoTargetId, url);
  }
  for (const row of rows) row.externalUrl ??= urls.get(row.id) ?? null;
}

function snapshotUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : null;
}

export function videoSnapshots(
  backendDb: BackendDb,
  rows: TargetRow[],
  start: Date,
  end: Date,
  bucketSeconds: number,
): Map<number, VideoSnapshot[]> {
  const snapshots = new Map<number, VideoSnapshot[]>();
  if (!rows.length) return snapshots;
  const placeholders = rows.map(() => "?").join(",");
  const bucketFactor = 86_400 / bucketSeconds;
  const samples = unsafeDb(backendDb)
    .sqlite.prepare(
      `WITH bucketed AS (
           SELECT id, video_target_id AS targetId,
                  ROW_NUMBER() OVER (
                    PARTITION BY video_target_id, CAST((julianday(sampled_at) - julianday(?)) * ? AS INTEGER)
                    ORDER BY sampled_at DESC, id DESC
                  ) AS bucketRank
             FROM video_metric_snapshots
            WHERE video_target_id IN (${placeholders})
              AND sampled_at >= ? AND sampled_at <= ?
         ),
         selected AS (
           SELECT id FROM bucketed WHERE bucketRank = 1
         ),
         baseline AS (
           SELECT id, video_target_id AS targetId,
                  ROW_NUMBER() OVER (PARTITION BY video_target_id ORDER BY sampled_at DESC, id DESC) AS rowNumber
             FROM video_metric_snapshots
            WHERE video_target_id IN (${placeholders}) AND sampled_at < ?
         ),
         latest AS (
           SELECT id, video_target_id AS targetId,
                  ROW_NUMBER() OVER (PARTITION BY video_target_id ORDER BY sampled_at DESC, id DESC) AS rowNumber
             FROM video_metric_snapshots
            WHERE video_target_id IN (${placeholders})
         ),
         wanted AS (
           SELECT id FROM selected
           UNION
           SELECT id FROM baseline WHERE rowNumber = 1
           UNION
           SELECT id FROM latest WHERE rowNumber = 1
         )
         SELECT video_target_id AS targetId,
                sampled_at AS sampledAt,
                CAST(COALESCE(json_extract(metrics_json, '$.views'), 0) AS REAL) AS views,
                CAST(COALESCE(json_extract(metrics_json, '$.likes'), 0) AS REAL) AS likes,
                CAST(COALESCE(json_extract(metrics_json, '$.comments'), 0) AS REAL) AS comments,
                COALESCE(json_extract(metrics_json, '$.averageWatchTimeMs'), json_extract(metrics_json, '$.averageWatchTime')) AS averageWatchTimeMs,
                COALESCE(json_extract(metrics_json, '$.totalWatchTimeMs'), json_extract(metrics_json, '$.totalWatchTime')) AS totalWatchTimeMs,
                COALESCE(json_extract(metrics_json, '$.follows'), json_extract(metrics_json, '$.subscribersGained')) AS follows,
                COALESCE(json_extract(metrics_json, '$.completionRate'), json_extract(metrics_json, '$.completion_rate'), json_extract(metrics_json, '$.completionPercentage'), json_extract(metrics_json, '$.completion_percentage')) AS completionRate,
                COALESCE(json_extract(metrics_json, '$.videoDurationMs'), json_extract(metrics_json, '$.durationMs')) AS videoDurationMs
           FROM video_metric_snapshots AS sample
          WHERE video_target_id IN (${placeholders}) AND id IN (SELECT id FROM wanted)
          ORDER BY targetId ASC, sampledAt ASC, id ASC`,
    )
    .all(
      start.toISOString(),
      bucketFactor,
      ...rows.map((row) => row.id),
      start.toISOString(),
      end.toISOString(),
      ...rows.map((row) => row.id),
      start.toISOString(),
      ...rows.map((row) => row.id),
      ...rows.map((row) => row.id),
    ) as Array<{
    targetId: number;
    sampledAt: string;
    views: number;
    likes: number;
    comments: number;
    averageWatchTimeMs: unknown;
    totalWatchTimeMs: unknown;
    follows: unknown;
    completionRate: unknown;
    videoDurationMs: unknown;
  }>;
  for (const sample of samples) {
    const at = new Date(sample.sampledAt);
    if (Number.isNaN(at.getTime())) continue;
    const list = snapshots.get(sample.targetId) ?? [];
    list.push({
      at,
      metrics: {
        views: metricNumber(sample.views),
        likes: metricNumber(sample.likes),
        comments: metricNumber(sample.comments),
        averageWatchTimeMs: optionalMetric(sample.averageWatchTimeMs),
        totalWatchTimeMs: optionalMetric(sample.totalWatchTimeMs),
        follows: optionalMetric(sample.follows),
        completionRate: optionalMetric(sample.completionRate),
        videoDurationMs: optionalMetric(sample.videoDurationMs),
      },
    });
    snapshots.set(sample.targetId, list);
  }
  for (const row of rows) {
    const history = snapshots.get(row.id) ?? [];
    snapshots.set(row.id, history);
  }
  return snapshots;
}

export function publishedDestinationKeys(backendDb: BackendDb, catalogue: readonly VideoDestination[]): Set<string> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
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
export function viewEvents(rows: TargetRow[], snapshots: Map<number, VideoSnapshot[]>, start: Date, end: Date): MetricEvent[] {
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

export function aggregateDailyMetrics(
  backendDb: BackendDb,
  rows: TargetRow[],
  snapshots: Map<number, VideoSnapshot[]>,
  days: PeriodDay[],
  cache?: VideoOverviewCache,
): Record<string, DailyVideoMetrics> {
  const result: Record<string, DailyVideoMetrics> = {};
  for (const day of days) result[day.key] = emptyDailyVideoMetrics();
  for (const row of rows) {
    const history = snapshots.get(row.id) ?? [];
    for (const day of days) {
      const before = latestAtOrBefore(history, day.start)?.metrics ?? emptyMetrics();
      const atEnd = latestAtOrBefore(history, day.end)?.metrics ?? before;
      const bucket = result[day.key] ?? emptyDailyVideoMetrics();
      bucket.views += Math.max(0, atEnd.views - before.views);
      bucket.reactions += Math.max(0, atEnd.likes - before.likes);
      bucket.replies += Math.max(0, atEnd.comments - before.comments);
      result[day.key] = bucket;
    }
  }
  const profileKeys = new Set(rows.map(profileKeyForRow).filter((key): key is string => key !== null));
  const growthKey = `${days.map((day) => `${day.start.toISOString()}|${day.end.toISOString()}`).join(",")}|${[...profileKeys].sort().join(",")}`;
  const growthByDay = cache?.audienceGrowthByDay.get(growthKey) ?? audienceGrowthByDay(backendDb, days, profileKeys);
  cache?.audienceGrowthByDay.set(growthKey, growthByDay);
  for (const day of days) {
    const growth = growthByDay.get(day.key);
    const values = [...profileKeys].filter((key) => growth?.has(key)).map((key) => growth?.get(key) ?? 0);
    const bucket = result[day.key] ?? emptyDailyVideoMetrics();
    bucket.subscribers = values.length ? values.reduce((total, value) => total + value, 0) : null;
    result[day.key] = bucket;
  }
  return result;
}

/** Loads audience history once for the whole chart instead of rerunning the
 * same window query once per calendar day. */
export function audienceGrowthByDay(backendDb: BackendDb, days: PeriodDay[], profileKeys: Set<string>): Map<string, Map<string, number>> {
  const lastDay = days.at(-1);
  if (!days.length || !lastDay || profileKeys.size === 0) return new Map();

  const platformNames = [...profileKeys];
  const placeholders = platformNames.map(() => "?").join(",");
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT platform, account, sampled_at AS sampledAt,
              CAST(COALESCE(json_extract(metrics_json, '$.subscriberCount'), json_extract(metrics_json, '$.followersCount'), 0) AS INTEGER) AS value
         FROM creator_profile_snapshots
        WHERE platform IN (${placeholders}) AND sampled_at <= ?
        ORDER BY platform ASC, account ASC, sampled_at ASC, id ASC`,
    )
    .all(...platformNames, lastDay.end.toISOString()) as Array<{
    platform: string;
    account: string;
    sampledAt: string;
    value: number;
  }>;
  const histories = new Map<string, Array<{ sampledAt: string; value: number }>>();
  for (const row of rows) {
    const key = `${row.platform}\u0000${row.account}`;
    const history = histories.get(key) ?? [];
    history.push({ sampledAt: row.sampledAt, value: row.value });
    histories.set(key, history);
  }

  const totals = new Map<string, Map<string, number>>();
  for (const [accountKey, history] of histories) {
    const separator = accountKey.indexOf("\u0000");
    const platform = separator < 0 ? accountKey : accountKey.slice(0, separator);
    let cursor = 0;
    let baseline: { sampledAt: string; value: number } | undefined;
    for (const day of days) {
      while (cursor < history.length && (history[cursor]?.sampledAt ?? "") <= day.start.toISOString()) {
        baseline = history[cursor];
        cursor += 1;
      }
      let current = baseline;
      while (cursor < history.length && (history[cursor]?.sampledAt ?? "") <= day.end.toISOString()) {
        current = history[cursor];
        cursor += 1;
      }
      if (!baseline || !current) continue;
      const dayTotals = totals.get(day.key) ?? new Map<string, number>();
      dayTotals.set(platform, (dayTotals.get(platform) ?? 0) + current.value - baseline.value);
      totals.set(day.key, dayTotals);
    }
  }
  return totals;
}

export function periodMetrics(history: VideoSnapshot[], days: PeriodDay[]): { totals: DailyMetrics } {
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

export function periodSubscriberDelta(history: VideoSnapshot[], days: PeriodDay[]): number | null {
  let total = 0;
  let observed = false;
  for (const day of days) {
    const before = latestAtOrBefore(history, day.start)?.metrics ?? emptyMetrics();
    const atEnd = latestAtOrBefore(history, day.end)?.metrics ?? before;
    if (before.follows === null && atEnd.follows === null) continue;
    observed = true;
    total += (atEnd.follows ?? before.follows ?? 0) - (before.follows ?? 0);
  }
  return observed ? total : null;
}

export function latestAtOrBefore(history: VideoSnapshot[], cutoff: Date): VideoSnapshot | undefined {
  let low = 0;
  let high = history.length - 1;
  let latest: VideoSnapshot | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const sample = history[middle];
    if (!sample) break;
    if (sample.at <= cutoff) {
      latest = sample;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return latest;
}

export function calendarDays(start: Date, end: Date, timeZone: string): PeriodDay[] {
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

export function calendarKey(value: Date, timeZone: string): string {
  const parts = zonedDateParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function emptyMetrics(): VideoMetrics {
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

export function emptyDailyMetrics(): DailyMetrics {
  return { views: 0, reactions: 0, replies: 0 };
}

export function emptyDailyVideoMetrics(): DailyVideoMetrics {
  return { ...emptyDailyMetrics(), subscribers: null };
}

export function followerCounts(backendDb: BackendDb): Map<string, number> {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT platform,
              CAST(COALESCE(json_extract(metrics_json, '$.subscriberCount'), json_extract(metrics_json, '$.followersCount'), 0) AS INTEGER) AS value
         FROM creator_profile_snapshots
        WHERE id IN (SELECT MAX(id) FROM creator_profile_snapshots GROUP BY platform, account)`,
    )
    .all() as Array<{ platform: string; value: number }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    // Snapshots exist per (platform, account); the overview panel is per
    // platform, so the accounts publishing through one platform are summed.
    counts.set(row.platform, (counts.get(row.platform) ?? 0) + metricNumber(row.value));
  }
  return counts;
}

export function destinationFor(
  catalogue: readonly VideoDestination[],
  row: { target: string; locale: string | null },
): VideoDestination | null {
  const locale = videoLocale(row.locale);
  return locale ? videoDestination(catalogue, row.target, locale) : null;
}

export function destinationKey(destination: VideoDestination): string {
  return `${destination.target}:${destination.locale}`;
}

export function videoLocale(value: string | null): VideoLocale | null {
  return value === "ru" || value === "en" ? value : null;
}

export function videoSummaryMetrics(
  backendDb: BackendDb,
  rows: TargetRow[],
  snapshots: Map<number, VideoSnapshot[]>,
  periodDays: PeriodDay[],
  end: Date,
  timeZone: string,
  cache?: VideoOverviewCache,
): VideoSummaryMetrics {
  const watchSamples: Array<{ value: number; weight: number }> = [];
  const completionSamples: Array<{ value: number; weight: number }> = [];
  let attributedSubscribers = 0;
  let hasAttributedSubscribers = false;

  for (const row of rows) {
    const history = snapshots.get(row.id) ?? [];
    const latest = latestAtOrBefore(history, end)?.metrics;
    if (!latest) continue;
    const weight = Math.max(1, periodMetrics(history, periodDays).totals.views || latest.views);
    if (latest.averageWatchTimeMs !== null && latest.averageWatchTimeMs > 0)
      watchSamples.push({ value: latest.averageWatchTimeMs, weight });
    if (latest.completionRate !== null && latest.completionRate >= 0) completionSamples.push({ value: latest.completionRate, weight });
    const durationMs = latest.videoDurationMs !== null && latest.videoDurationMs > 0 ? latest.videoDurationMs : targetDurationMs(row);
    if (latest.totalWatchTimeMs !== null && latest.views > 0 && durationMs !== null && durationMs > 0) {
      completionSamples.push({
        value: Math.min(100, (latest.totalWatchTimeMs / (latest.views * durationMs)) * 100),
        weight,
      });
    }
  }

  // Account reports are the fallback for subscriber attribution. They are only
  // valid for the current calendar day; reusing today's 1d/7d report for a
  // historical dashboard window would make an old date move when the account
  // sync runs again.
  const reportDays = reportPeriodDays(periodDays.length);
  let profileSubscribers = 0;
  let hasProfileSubscribers = false;
  let accountProfileKeys = new Set<string>();
  if (isCurrentCalendarDay(end, timeZone) && reportDays !== null) {
    const profileKey = `${reportDays}|${[...new Set(rows.map(profileKeyForRow).filter((key): key is string => key !== null))].sort().join(",")}`;
    const profileMetrics = cache?.profileSummaries.get(profileKey) ?? profileSummaryMetrics(backendDb, rows, reportDays);
    cache?.profileSummaries.set(profileKey, profileMetrics);
    if (profileMetrics.averageWatchTimeMs !== null)
      watchSamples.push({ value: profileMetrics.averageWatchTimeMs, weight: Math.max(1, profileMetrics.views) });
    if (profileMetrics.completionRate !== null)
      completionSamples.push({ value: profileMetrics.completionRate, weight: Math.max(1, profileMetrics.views) });
    profileSubscribers = profileMetrics.subscribers;
    hasProfileSubscribers = profileMetrics.hasSubscribers;
    accountProfileKeys = profileMetrics.accountProfileKeys;
  }

  const audienceDays = reportDays ?? periodDays.length;
  const audienceStart = periodDays[0]?.start.toISOString() ?? end.toISOString();
  const useCurrentProviderReports = isCurrentCalendarDay(end, timeZone) && reportDays !== null;
  const audienceKey = `${audienceStart}|${audienceDays}|${end.toISOString()}|${useCurrentProviderReports ? "provider" : "history"}`;
  const audienceGrowth =
    cache?.audienceGrowth.get(audienceKey) ??
    audienceGrowthByPlatform(backendDb, audienceStart, audienceDays, end.toISOString(), useCurrentProviderReports);
  cache?.audienceGrowth.set(audienceKey, audienceGrowth);
  for (const row of rows) {
    const profileKey = profileKeyForRow(row);
    if (profileKey === null || accountProfileKeys.has(profileKey) || !audienceGrowth.has(profileKey)) continue;
    profileSubscribers += audienceGrowth.get(profileKey) ?? 0;
    hasProfileSubscribers = true;
    accountProfileKeys.add(profileKey);
  }

  // Do not add a per-video number for a channel whose account report already
  // covers it — that would double-count the same subscriber change.
  for (const row of rows) {
    const profileKey = profileKeyForRow(row);
    if (profileKey !== null && accountProfileKeys.has(profileKey)) continue;
    const latest = latestAtOrBefore(snapshots.get(row.id) ?? [], end)?.metrics;
    if (latest?.follows !== null && latest?.follows !== undefined && latest.follows !== 0) {
      attributedSubscribers += latest.follows;
      hasAttributedSubscribers = true;
    }
  }

  return {
    completionRate: weightedAverage(completionSamples),
    averageWatchTimeMs: weightedAverage(watchSamples),
    subscribers: hasProfileSubscribers || hasAttributedSubscribers ? profileSubscribers + attributedSubscribers : null,
  };
}

function reportPeriodDays(days: number): 1 | 7 | 30 | null {
  return days === 1 || days === 7 || days === 30 ? days : null;
}

export type ProfileSummaryMetrics = {
  averageWatchTimeMs: number | null;
  completionRate: number | null;
  subscribers: number;
  hasSubscribers: boolean;
  accountProfileKeys: Set<string>;
  views: number;
};

export function profileSummaryMetrics(backendDb: BackendDb, rows: TargetRow[], days: number): ProfileSummaryMetrics {
  const reportDays = days === 1 ? 1 : days === 7 ? 7 : 30;
  const suffix = reportDays === 30 ? "" : `${reportDays}d`;
  const accountKeys = new Set(rows.map(profileKeyForRow).filter((key): key is string => key !== null));
  let averageWatchTotal = 0;
  let averageWatchWeight = 0;
  let completionTotal = 0;
  let completionWeight = 0;
  let subscribers = 0;
  let hasSubscribers = false;
  let views = 0;
  const accountProfileKeys = new Set<string>();
  for (const profile of unsafeDb(backendDb).db.select().from(creatorProfiles).all()) {
    if (!accountKeys.has(profile.platform)) continue;
    const data = profile.dataJson as Record<string, unknown>;
    const periodViews = optionalMetric(data[`views${suffix}`] ?? data.views ?? data.viewCount) ?? 0;
    if (profile.platform.startsWith("youtube")) {
      const gained = optionalMetric(data[`subscribersGained${suffix}`] ?? data.subscribersGained);
      const lost = optionalMetric(data[`subscribersLost${suffix}`] ?? data.subscribersLost);
      const reportHasData = periodViews > 0 || (gained !== null && gained !== 0) || (lost !== null && lost !== 0);
      if (!reportHasData) continue;
      const averageViewDuration = optionalMetric(data[`averageViewDuration${suffix}`] ?? data.averageViewDuration);
      if (averageViewDuration !== null && averageViewDuration > 0) {
        const weight = Math.max(1, periodViews);
        averageWatchTotal += averageViewDuration * 1_000 * weight;
        averageWatchWeight += weight;
      }
      const averageViewPercentage = optionalMetric(data[`averageViewPercentage${suffix}`] ?? data.averageViewPercentage);
      if (averageViewPercentage !== null && averageViewPercentage >= 0) {
        const weight = Math.max(1, periodViews);
        completionTotal += averageViewPercentage * weight;
        completionWeight += weight;
      }
      if (gained !== null || lost !== null) {
        subscribers += (gained ?? 0) - (lost ?? 0);
        hasSubscribers = true;
        accountProfileKeys.add(profile.platform);
      }
    } else if (profile.platform.startsWith("instagram")) {
      const gained = optionalMetric(data.followersGained30d ?? data.followersGained);
      const lost = optionalMetric(data.followersLost30d ?? data.followersLost);
      if (reportDays !== 30 || (gained === null && lost === null)) continue;
      subscribers += (gained ?? 0) - (lost ?? 0);
      hasSubscribers = true;
      accountProfileKeys.add(profile.platform);
    }
    views += periodViews;
  }
  return {
    averageWatchTimeMs: averageWatchWeight > 0 ? averageWatchTotal / averageWatchWeight : null,
    completionRate: completionWeight > 0 ? completionTotal / completionWeight : null,
    subscribers,
    hasSubscribers,
    accountProfileKeys,
    views,
  };
}

export function profileKeyForRow(row: TargetRow): string | null {
  if (row.target !== "youtube_shorts" && row.target !== "instagram_reels") return null;
  if (row.locale !== "ru" && row.locale !== "en") return null;
  return `${row.target === "youtube_shorts" ? "youtube" : "instagram"}_${row.locale}`;
}

export function targetDurationMs(row: TargetRow): number | null {
  const metadata = parseJson(row.metadataJson);
  const milliseconds = optionalMetric(metadata.videoDurationMs ?? metadata.durationMs);
  if (milliseconds !== null && milliseconds > 0) return milliseconds;
  const seconds = optionalMetric(metadata.videoDuration ?? metadata.duration);
  return seconds !== null && seconds > 0 ? seconds * 1_000 : null;
}

export function isCurrentCalendarDay(value: Date, timeZone: string): boolean {
  const current = zonedDateParts(new Date(), timeZone);
  const target = zonedDateParts(value, timeZone);
  return current.year === target.year && current.month === target.month && current.day === target.day;
}

export function optionalMetric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function weightedAverage(samples: Array<{ value: number; weight: number }>): number | null {
  if (!samples.length) return null;
  const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  return weight > 0 ? samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / weight : null;
}

export function parseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function videoLabel(target: string): string {
  const known = VIDEO_TARGETS.find((candidate) => candidate === target);
  return known ? videoTargetLabel(known) : target;
}
