import type { BackendDb } from "../db/client.js";
import { metricNumber } from "./snapshots/creator-store.js";

/** Single source for period-delta analytics shared by every report and dashboard.
 * Post/video engagement lives in metric_samples; audience growth in
 * creator_profile_snapshots. Callers differ only in how they aggregate the deltas. */

export type VideoMetricRow = { platform: string; label: string; metrics: Record<string, unknown> };

/** NUL joins composite map keys so account display names (which can contain any
 * printable character) never collide with the separator. */
export const KEY_SEP = String.fromCharCode(0);

type MetricSeries = { target: string; metric: string; firstAt: string; latest: number; baseline: number | null };

/** One row per (post, target, metric) with its latest value and the last value
 * at or before `since`. This is the primitive every metric_samples projection
 * is built on, so the scan and baseline rule exist in exactly one place. */
export function metricSeriesSince(backendDb: BackendDb, since: string, where = "1=1"): MetricSeries[] {
  const rows = backendDb.sqlite
    .prepare(`SELECT post_key, target, metric_name, value, sampled_at FROM metric_samples WHERE ${where} ORDER BY sampled_at ASC, id ASC`)
    .all() as Array<{ post_key: string; target: string; metric_name: string; value: number | null; sampled_at: string }>;
  const series = new Map<string, MetricSeries>();
  for (const row of rows) {
    const key = `${row.post_key}${KEY_SEP}${row.target}${KEY_SEP}${row.metric_name}`;
    const value = metricNumber(row.value);
    const entry = series.get(key) ?? {
      target: row.target,
      metric: row.metric_name,
      firstAt: row.sampled_at,
      latest: value,
      baseline: null,
    };
    entry.latest = value;
    if (row.sampled_at <= since) entry.baseline = value;
    series.set(key, entry);
  }
  return [...series.values()];
}

/** metric_samples delta summed per metric name, filtered by a raw target predicate. */
export function metricDeltasSince(backendDb: BackendDb, since: string, where: string): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const entry of metricSeriesSince(backendDb, since, where)) {
    if (entry.baseline == null && entry.firstAt < since) continue;
    totals[entry.metric] = (totals[entry.metric] ?? 0) + Math.max(0, entry.latest - (entry.baseline ?? 0));
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
    if (!baseline && !(row.published_at != null && row.published_at >= since)) return [];
    const metrics = Object.fromEntries(
      Object.entries(latest).map(([key, value]) => [key, Math.max(0, metricNumber(value) - metricNumber(baseline?.[key]))]),
    );
    return [{ platform: row.platform, label: row.label, metrics }];
  });
}

export function videoTotals(backendDb: BackendDb, since: string): { views: number; interactions: number } {
  const rows = latestVideoMetrics(backendDb, since);
  return { views: sum(rows, "views"), interactions: sum(rows, "likes") + sum(rows, "comments") };
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
      "SELECT platform, account, metrics_json, sampled_at, id FROM creator_profile_snapshots ORDER BY platform, account, sampled_at ASC, id ASC",
    )
    .all() as Array<{ platform: string; account: string; metrics_json: string; sampled_at: string }>;
  const byAccount = new Map<string, { latest: number; baseline: number | null }>();
  for (const row of rows) {
    const data = JSON.parse(row.metrics_json) as Record<string, unknown>;
    const key = `${row.platform}${KEY_SEP}${row.account}`;
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
