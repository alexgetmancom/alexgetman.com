import type { BackendDb } from "../db/client.js";
import { log } from "../foundation/logger.js";

/** Curated operation boundaries that are useful when deciding what to simplify.
 * Dynamic providers and channels are intentionally represented by one stable
 * operation key so provider names cannot create unbounded metric cardinality. */
const TRACKED_FEATURES = [
  "publishing.plan.create",
  "publishing.social.job",
  "publishing.video.job",
  "publishing.site.materialize",
  "content.story_card.render",
  "analytics.metrics.collect",
  "analytics.creator_profile.sync",
  "analytics.video_metrics.collect",
  "engagement.pageview.record",
  "engagement.likes.lookup",
  "engagement.likes.batch",
  "engagement.likes.toggle",
  "command_center.dashboard.view",
  "command_center.pipeline.view",
  "command_center.post_debug.view",
  "command_center.action.execute",
  "studio.mcp.request",
  "telegram.update.handle",
] as const;

const featureKeyPattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const millisecondsPerDay = 24 * 60 * 60 * 1000;

type UsageAggregate = {
  featureKey: string;
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  daysWithCalls: number;
};

export type UsageReport = {
  generatedAt: string;
  windowDays: number;
  unusedDays: number;
  since: string;
  features: Array<UsageAggregate & { averageDurationMs: number; unused: boolean; daysSinceLastSeen: number | null }>;
};

/** Records one operation without allowing telemetry failures to change the
 * operation being observed. It is safe to call while another SQLite transaction
 * is active because it only executes the upsert statement. */
export function recordUsage(backendDb: BackendDb, featureKey: string, success: boolean, durationMs: number, now = new Date()): void {
  if (!featureKeyPattern.test(featureKey)) {
    log("warn", "invalid runtime usage feature key", { featureKey });
    return;
  }
  const timestamp = now.toISOString();
  const bucketDay = timestamp.slice(0, 10);
  try {
    backendDb.sqlite
      .prepare(
        `INSERT INTO runtime_usage
          (feature_key, bucket_day, calls, successes, failures, total_duration_ms, first_seen_at, last_seen_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(feature_key, bucket_day) DO UPDATE SET
           calls = runtime_usage.calls + 1,
           successes = runtime_usage.successes + excluded.successes,
           failures = runtime_usage.failures + excluded.failures,
           total_duration_ms = runtime_usage.total_duration_ms + excluded.total_duration_ms,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(featureKey, bucketDay, success ? 1 : 0, success ? 0 : 1, Math.max(0, Math.round(durationMs)), timestamp, timestamp);
  } catch (error) {
    log("warn", "runtime usage record failed", { featureKey, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Synchronous wrapper for a domain operation. */
export function trackUsageSync<T>(backendDb: BackendDb, featureKey: string, operation: () => T): T {
  const startedAt = Date.now();
  try {
    const result = operation();
    recordUsage(backendDb, featureKey, true, Date.now() - startedAt);
    return result;
  } catch (error) {
    recordUsage(backendDb, featureKey, false, Date.now() - startedAt);
    throw error;
  }
}

/** Async counterpart used around provider calls and other long-running work. */
export async function trackUsageAsync<T>(backendDb: BackendDb, featureKey: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    recordUsage(backendDb, featureKey, true, Date.now() - startedAt);
    return result;
  } catch (error) {
    recordUsage(backendDb, featureKey, false, Date.now() - startedAt);
    throw error;
  }
}

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function positiveDays(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 3660) throw new Error("usage day window must be an integer between 1 and 3660");
  return value;
}

/** Returns a windowed report and includes known operations with zero calls. */
export function usageReport(backendDb: BackendDb, options: { days?: number; unusedDays?: number; now?: Date } = {}): UsageReport {
  const now = options.now ?? new Date();
  const windowDays = positiveDays(options.days, 30);
  const unusedDays = positiveDays(options.unusedDays, 90);
  const sinceDate = new Date(now.getTime() - (windowDays - 1) * millisecondsPerDay);
  const unusedSinceDate = new Date(now.getTime() - (unusedDays - 1) * millisecondsPerDay);
  const rows = backendDb.sqlite
    .prepare(
      `SELECT
         feature_key AS featureKey,
         COALESCE(SUM(CASE WHEN bucket_day >= ? THEN calls ELSE 0 END), 0) AS calls,
         COALESCE(SUM(CASE WHEN bucket_day >= ? THEN successes ELSE 0 END), 0) AS successes,
         COALESCE(SUM(CASE WHEN bucket_day >= ? THEN failures ELSE 0 END), 0) AS failures,
         COALESCE(SUM(CASE WHEN bucket_day >= ? THEN total_duration_ms ELSE 0 END), 0) AS totalDurationMs,
         MIN(first_seen_at) AS firstSeenAt,
         MAX(last_seen_at) AS lastSeenAt,
         COALESCE(SUM(CASE WHEN bucket_day >= ? THEN 1 ELSE 0 END), 0) AS daysWithCalls
       FROM runtime_usage
       GROUP BY feature_key`,
    )
    .all(dayString(sinceDate), dayString(sinceDate), dayString(sinceDate), dayString(sinceDate), dayString(sinceDate)) as UsageAggregate[];
  const byFeature = new Map(rows.map((row) => [row.featureKey, row]));
  const featureKeys = new Set<string>([...TRACKED_FEATURES, ...byFeature.keys()]);
  const unusedSince = dayString(unusedSinceDate);
  const features = [...featureKeys].map((featureKey) => {
    const row = byFeature.get(featureKey);
    const aggregate: UsageAggregate = {
      featureKey,
      calls: Number(row?.calls ?? 0),
      successes: Number(row?.successes ?? 0),
      failures: Number(row?.failures ?? 0),
      totalDurationMs: Number(row?.totalDurationMs ?? 0),
      firstSeenAt: row?.firstSeenAt ?? null,
      lastSeenAt: row?.lastSeenAt ?? null,
      daysWithCalls: Number(row?.daysWithCalls ?? 0),
    };
    const lastSeenDay = aggregate.lastSeenAt?.slice(0, 10);
    const unused = !lastSeenDay || lastSeenDay < unusedSince;
    const daysSinceLastSeen = aggregate.lastSeenAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(aggregate.lastSeenAt).getTime()) / millisecondsPerDay))
      : null;
    return {
      ...aggregate,
      averageDurationMs: aggregate.calls ? Math.round(aggregate.totalDurationMs / aggregate.calls) : 0,
      unused,
      daysSinceLastSeen,
    };
  });
  features.sort((left, right) => right.calls - left.calls || left.featureKey.localeCompare(right.featureKey));
  return {
    generatedAt: now.toISOString(),
    windowDays,
    unusedDays,
    since: sinceDate.toISOString(),
    features,
  };
}
