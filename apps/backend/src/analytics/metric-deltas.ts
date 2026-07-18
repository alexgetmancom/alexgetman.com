import type { BackendDb } from "../db/client.js";
import { metricNumber } from "./snapshots/creator-store.js";

/** Single source for period-delta analytics shared by every report and dashboard.
 * Post/video engagement lives in metric_samples; audience growth in
 * creator_profile_snapshots. Callers differ only in how they aggregate the deltas.
 * Both queries below let SQLite (via idx_metric_samples_lookup) find the
 * latest/baseline row per group instead of pulling the whole matched history
 * into JS and reducing it there. */

export type VideoMetricRow = { platform: string; label: string; metrics: Record<string, unknown> };
export type ContentMetrics = { views: number; likes: number; comments: number; shares: number; saves: number };

/** NUL joins composite map keys so account display names (which can contain any
 * printable character) never collide with the separator. */
export const KEY_SEP = String.fromCharCode(0);

type MetricSeries = { target: string; metric: string; firstAt: string; latest: number; baseline: number | null };

/** One row per (post, target, metric) with its latest value and the last value
 * at or before `since`. This is the primitive every metric_samples projection
 * is built on, so the scan and baseline rule exist in exactly one place. */
export function metricSeriesSince(backendDb: BackendDb, since: string, where = "1=1"): MetricSeries[] {
  const rows = backendDb.sqlite
    .prepare(
      `WITH matched AS (
         SELECT post_key, target, metric_name, value, sampled_at, id FROM metric_samples WHERE ${where}
       ),
       ranked_latest AS (
         SELECT post_key, target, metric_name, value,
                ROW_NUMBER() OVER (PARTITION BY post_key, target, metric_name ORDER BY sampled_at DESC, id DESC) AS rn
         FROM matched
       ),
       ranked_baseline AS (
         SELECT post_key, target, metric_name, value,
                ROW_NUMBER() OVER (PARTITION BY post_key, target, metric_name ORDER BY sampled_at DESC, id DESC) AS rn
         FROM matched WHERE sampled_at <= ?
       ),
       first_seen AS (
         SELECT post_key, target, metric_name, MIN(sampled_at) AS first_at FROM matched GROUP BY post_key, target, metric_name
       )
       SELECT f.target AS target, f.metric_name AS metric_name, f.first_at AS first_at,
              CAST(COALESCE(l.value, 0) AS INTEGER) AS latest,
              CASE WHEN b.post_key IS NOT NULL THEN CAST(COALESCE(b.value, 0) AS INTEGER) ELSE NULL END AS baseline
       FROM first_seen f
       JOIN ranked_latest l ON l.post_key = f.post_key AND l.target = f.target AND l.metric_name = f.metric_name AND l.rn = 1
       LEFT JOIN ranked_baseline b ON b.post_key = f.post_key AND b.target = f.target AND b.metric_name = f.metric_name AND b.rn = 1`,
    )
    .all(since) as Array<{ target: string; metric_name: string; first_at: string; latest: number; baseline: number | null }>;
  return rows.map((row) => ({
    target: row.target,
    metric: row.metric_name,
    firstAt: row.first_at,
    latest: row.latest,
    baseline: row.baseline,
  }));
}

/** metric_samples delta summed per metric name, filtered by a raw target predicate. */
function metricDeltasSince(backendDb: BackendDb, since: string, where: string): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const entry of metricSeriesSince(backendDb, since, where)) {
    if (entry.baseline == null && entry.firstAt < since) continue;
    totals[entry.metric] = (totals[entry.metric] ?? 0) + Math.max(0, entry.latest - (entry.baseline ?? 0));
  }
  return totals;
}

/** Text-post metric deltas grouped by delivery target. `reposts` is the
 * platform's share/forward action and is rendered as “пересылки” in UI. */
export function textContentMetricsByPlatform(backendDb: BackendDb, since: string): Map<string, ContentMetrics> {
  const totals = new Map<string, ContentMetrics>();
  for (const entry of metricSeriesSince(backendDb, since, "target NOT LIKE 'site_%'")) {
    if (entry.baseline == null && entry.firstAt < since) continue;
    const value = totals.get(entry.target) ?? { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
    const delta = Math.max(0, entry.latest - (entry.baseline ?? 0));
    if (entry.metric === "views") value.views += delta;
    else if (entry.metric === "likes") value.likes += delta;
    else if (entry.metric === "comments" || entry.metric === "replies") value.comments += delta;
    else if (entry.metric === "reposts") value.shares += delta;
    else if (entry.metric === "saves") value.saves += delta;
    totals.set(entry.target, value);
  }
  return totals;
}

export function textTotals(backendDb: BackendDb, since: string): { views: number; interactions: number } {
  const totals = metricDeltasSince(backendDb, since, "target NOT LIKE 'site_%'");
  return {
    views: totals.views ?? 0,
    interactions: (totals.likes ?? 0) + (totals.replies ?? 0) + (totals.reposts ?? 0) + (totals.comments ?? 0),
  };
}

export function siteTotal(backendDb: BackendDb, since: string): number {
  return metricDeltasSince(backendDb, since, "target LIKE 'site_%'").views ?? 0;
}

export function latestVideoMetrics(backendDb: BackendDb, since: string): VideoMetricRow[] {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT target.target AS platform, draft.label, target.published_at, latest.metrics_json AS latest_metrics, baseline.metrics_json AS baseline_metrics FROM video_targets target JOIN video_drafts draft ON draft.id = target.video_draft_id JOIN video_metric_snapshots latest ON latest.id = (SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id ORDER BY sampled_at DESC, id DESC LIMIT 1) LEFT JOIN video_metric_snapshots baseline ON baseline.id = (SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id AND sampled_at <= ? ORDER BY sampled_at DESC, id DESC LIMIT 1) WHERE target.status = 'published' ORDER BY latest.id DESC`,
    )
    .all(since) as Array<{
    platform: string;
    label: string;
    published_at: string | null;
    latest_metrics: string;
    baseline_metrics: string | null;
  }>;
  return rows.flatMap((row) => {
    const latest = JSON.parse(row.latest_metrics) as Record<string, unknown>;
    const baseline = row.baseline_metrics ? (JSON.parse(row.baseline_metrics) as Record<string, unknown>) : null;
    const publishedInPeriod = row.published_at != null && row.published_at >= since;
    if (!baseline && !publishedInPeriod) return [];
    // A provider migration can leave a synthetic all-zero baseline for an
    // older video. Treating its lifetime count as this period's performance is
    // worse than temporarily omitting it, so wait for a real observation.
    if (!publishedInPeriod && baseline && !Object.values(baseline).some((value) => metricNumber(value) > 0)) return [];
    const metrics = Object.fromEntries(
      Object.entries(latest).map(([key, value]) => [key, Math.max(0, metricNumber(value) - metricNumber(baseline?.[key]))]),
    );
    return [{ platform: row.platform, label: row.label, metrics }];
  });
}

/** Per-platform video metrics for the selected period. `shares` is the Share
 * action (Instagram sends / YouTube share button), never a repost. */
export function videoContentMetricsByPlatform(backendDb: BackendDb, since: string): Map<string, ContentMetrics> {
  const totals = new Map<string, ContentMetrics>();
  for (const row of latestVideoMetrics(backendDb, since)) {
    const value = totals.get(row.platform) ?? { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
    value.views += metricNumber(row.metrics.views);
    value.likes += metricNumber(row.metrics.likes);
    value.comments += metricNumber(row.metrics.comments);
    value.shares += metricNumber(row.metrics.shares);
    value.saves += metricNumber(row.metrics.saves);
    totals.set(row.platform, value);
  }
  return totals;
}

export function sum(rows: VideoMetricRow[], field: string): number {
  return rows.reduce((total, row) => total + metricNumber(row.metrics[field]), 0);
}

/** Current projection minus the last observation at or before `since`, keyed by
 * `platform${KEY_SEP}account`. A profile with no baseline is omitted rather than
 * counting its lifetime follower number as growth. */
export function audienceGrowthByAccount(backendDb: BackendDb, since: string): Map<string, number> {
  const rows = backendDb.sqlite
    .prepare(
      `WITH samples AS (
         SELECT platform, account, sampled_at, id,
                CAST(COALESCE(json_extract(metrics_json, '$.subscriberCount'), json_extract(metrics_json, '$.followersCount'), 0) AS INTEGER) AS value
         FROM creator_profile_snapshots
       ),
       ranked_latest AS (
         SELECT platform, account, value,
                ROW_NUMBER() OVER (PARTITION BY platform, account ORDER BY sampled_at DESC, id DESC) AS rn
         FROM samples
       ),
       ranked_baseline AS (
         SELECT platform, account, value,
                ROW_NUMBER() OVER (PARTITION BY platform, account ORDER BY sampled_at DESC, id DESC) AS rn
         FROM samples WHERE sampled_at <= ?
       )
       SELECT l.platform AS platform, l.account AS account, l.value AS latest,
              CASE WHEN b.platform IS NOT NULL THEN b.value ELSE NULL END AS baseline
       FROM ranked_latest l
       LEFT JOIN ranked_baseline b ON b.platform = l.platform AND b.account = l.account AND b.rn = 1
       WHERE l.rn = 1`,
    )
    .all(since) as Array<{ platform: string; account: string; latest: number; baseline: number | null }>;
  return new Map(
    rows.filter((row) => row.baseline != null).map((row) => [`${row.platform}${KEY_SEP}${row.account}`, row.latest - (row.baseline ?? 0)]),
  );
}
