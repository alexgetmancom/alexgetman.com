import { and, asc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { metricSchedule, posts, postTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { metricCheckpointAt } from "./metric-checkpoints.js";

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

const PAID_METRIC_TARGETS = ["x", "twitter"] as const;

export function ensureMetricSchedule(backendDb: BackendDb, targets: readonly string[]): void {
  if (targets.length === 0) return;
  const rows = backendDb.db
    .select({ postKey: posts.postKey, dateUtc: posts.dateUtc, target: postTargets.target })
    .from(posts)
    .innerJoin(postTargets, eq(postTargets.postKey, posts.postKey))
    .where(and(eq(posts.status, "active"), eq(postTargets.status, "published"), inArray(postTargets.target, [...targets])))
    .all();
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    for (const row of rows) {
      const publishedAt = parseDate(row.dateUtc);
      tx.insert(metricSchedule)
        .values({
          postKey: row.postKey,
          target: row.target,
          nextCheckAt: metricCheckpointAt(publishedAt.toISOString(), 0, publishedAt)?.toISOString() ?? publishedAt.toISOString(),
          frozenAt: null,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
  });
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

export function finishMetricTask(backendDb: BackendDb, task: MetricTask, error: string | null, terminal = false): void {
  const now = new Date();
  const nextIndex = error ? task.checkCount : task.checkCount + 1;
  const nextCheckpoint = terminal ? null : error ? new Date(now.getTime() + 15 * 60_000) : metricCheckpointAt(task.dateUtc, nextIndex, now);
  backendDb.db
    .update(metricSchedule)
    .set({
      nextCheckAt: nextCheckpoint?.toISOString() ?? null,
      lastCheckedAt: now.toISOString(),
      checkCount: error ? task.checkCount : sql`${metricSchedule.checkCount} + 1`,
      frozenAt: nextCheckpoint == null ? now.toISOString() : null,
      lastError: error,
      updatedAt: now.toISOString(),
    })
    .where(and(eq(metricSchedule.postKey, task.postKey), eq(metricSchedule.target, task.target)))
    .run();
}

export function freezeDisabledMetricSchedules(backendDb: BackendDb, targets: readonly string[]): void {
  if (targets.length === 0) return;
  const now = new Date().toISOString();
  backendDb.db
    .update(metricSchedule)
    .set({ frozenAt: now, nextCheckAt: null, lastError: null, updatedAt: now })
    .where(and(isNull(metricSchedule.frozenAt), inArray(metricSchedule.target, [...targets])))
    .run();
}

function parseDate(value: string | null): Date {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
