import { and, asc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { metricSchedule, posts, postTargets } from "../db/schema.js";

export type MetricTask = {
  postKey: string;
  target: string;
  checkCount: number;
  messageId: number;
  dateUtc: string | null;
  externalId: string | null;
  externalIds: string[];
  url: string | null;
};

const INTERVALS_MS = [3, 6, 12, 24, 48].map((hours) => hours * 3_600_000).concat([7 * 86_400_000, 30 * 86_400_000]);
const PAID_METRIC_TARGETS = ["x", "twitter"] as const;

export function ensureMetricSchedule(backendDb: BackendDb, targets: readonly string[]): number {
  if (targets.length === 0) return 0;
  const rows = backendDb.db
    .select({ postKey: posts.postKey, dateUtc: posts.dateUtc, target: postTargets.target })
    .from(posts)
    .innerJoin(postTargets, eq(postTargets.postKey, posts.postKey))
    .where(and(eq(posts.status, "active"), eq(postTargets.status, "published"), inArray(postTargets.target, [...targets])))
    .all();
  let changes = 0;
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    for (const row of rows) {
      const publishedAt = parseDate(row.dateUtc);
      tx.insert(metricSchedule)
        .values({
          postKey: row.postKey,
          target: row.target,
          nextCheckAt: new Date(publishedAt.getTime() + 3_600_000).toISOString(),
          frozenAt: null,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      changes += 1;
    }
  });
  return changes;
}

export function dueMetricTasks(backendDb: BackendDb, config: BackendConfig): MetricTask[] {
  const rows = backendDb.db
    .select({
      postKey: metricSchedule.postKey,
      target: metricSchedule.target,
      checkCount: metricSchedule.checkCount,
      messageId: posts.messageId,
      dateUtc: posts.dateUtc,
      externalId: postTargets.externalId,
      externalIds: postTargets.externalIdsJson,
      url: postTargets.url,
    })
    .from(metricSchedule)
    .innerJoin(posts, eq(posts.postKey, metricSchedule.postKey))
    .innerJoin(postTargets, and(eq(postTargets.postKey, metricSchedule.postKey), eq(postTargets.target, metricSchedule.target)))
    .where(
      and(
        isNull(metricSchedule.frozenAt),
        eq(postTargets.status, "published"),
        ...(config.ENABLE_X_METRICS ? [] : [notInArray(metricSchedule.target, [...PAID_METRIC_TARGETS])]),
        or(isNull(metricSchedule.nextCheckAt), lte(metricSchedule.nextCheckAt, new Date().toISOString())),
      ),
    )
    .orderBy(sql`${posts.dateUtc} DESC`, asc(metricSchedule.checkCount))
    .limit(config.MAX_METRIC_TASKS_PER_CYCLE)
    .all();
  return rows.map((row) => ({
    postKey: row.postKey,
    target: row.target,
    checkCount: row.checkCount,
    messageId: row.messageId,
    dateUtc: row.dateUtc,
    externalId: row.externalId,
    externalIds: row.externalIds ?? (row.externalId ? [row.externalId] : []),
    url: row.url,
  }));
}

export function finishMetricTask(backendDb: BackendDb, task: MetricTask, error: string | null): void {
  const now = new Date();
  const interval = INTERVALS_MS[task.checkCount];
  backendDb.db
    .update(metricSchedule)
    .set({
      nextCheckAt: interval == null ? null : new Date(now.getTime() + interval).toISOString(),
      lastCheckedAt: now.toISOString(),
      checkCount: sql`${metricSchedule.checkCount} + 1`,
      frozenAt: interval == null ? now.toISOString() : null,
      lastError: error,
      updatedAt: now.toISOString(),
    })
    .where(and(eq(metricSchedule.postKey, task.postKey), eq(metricSchedule.target, task.target)))
    .run();
}

function parseDate(value: string | null): Date {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
