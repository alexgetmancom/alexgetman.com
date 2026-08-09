import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { TARGET_GROUPS } from "../../botTargets.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
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
  lockId: string;
};

const PAID_METRIC_TARGETS = TARGET_GROUPS.x;

export function ensureMetricSchedule(backendDb: BackendDb, targets: readonly string[]): void {
  if (targets.length === 0) return;
  const rows = unsafeDb(backendDb)
    .db.select({ postKey: posts.postKey, dateUtc: posts.dateUtc, target: postTargets.target })
    .from(posts)
    .innerJoin(postTargets, eq(postTargets.postKey, posts.postKey))
    .leftJoin(metricSchedule, and(eq(metricSchedule.postKey, posts.postKey), eq(metricSchedule.target, postTargets.target)))
    .where(
      and(
        eq(posts.status, "active"),
        eq(postTargets.status, "published"),
        inArray(postTargets.target, [...targets]),
        isNull(metricSchedule.postKey),
      ),
    )
    .all();
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
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

export function claimDueMetricTasks(
  backendDb: BackendDb,
  config: BackendConfig,
  targets: readonly string[],
  worker = `metrics:${crypto.randomUUID()}`,
): MetricTask[] {
  if (targets.length === 0) return [];
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - config.METRIC_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const rows = unsafeDb(backendDb)
    .db.select({
      postKey: metricSchedule.postKey,
      target: metricSchedule.target,
      checkCount: metricSchedule.checkCount,
      messageId: posts.messageId,
      dateUtc: posts.dateUtc,
      externalId: postTargets.externalId,
      externalIds: postTargets.externalIdsJson,
      url: postTargets.url,
      lockedBy: metricSchedule.lockedBy,
      lockedAt: metricSchedule.lockedAt,
    })
    .from(metricSchedule)
    .innerJoin(posts, eq(posts.postKey, metricSchedule.postKey))
    .innerJoin(postTargets, and(eq(postTargets.postKey, metricSchedule.postKey), eq(postTargets.target, metricSchedule.target)))
    .where(
      and(
        isNull(metricSchedule.frozenAt),
        eq(postTargets.status, "published"),
        inArray(metricSchedule.target, [...targets]),
        ...(config.ENABLE_X_METRICS ? [] : [notInArray(metricSchedule.target, [...PAID_METRIC_TARGETS])]),
        or(isNull(metricSchedule.nextCheckAt), lte(metricSchedule.nextCheckAt, now)),
        or(isNull(metricSchedule.lockedBy), isNull(metricSchedule.lockedAt), lt(metricSchedule.lockedAt, cutoff)),
      ),
    )
    // Oldest due work must win. Ordering by the post date starved historical
    // checkpoints indefinitely whenever newer posts kept becoming due.
    .orderBy(asc(metricSchedule.nextCheckAt), asc(metricSchedule.checkCount), asc(posts.dateUtc))
    .limit(config.MAX_METRIC_TASKS_PER_CYCLE)
    .all();
  const claimed: MetricTask[] = [];
  unsafeDb(backendDb).db.transaction((tx) => {
    for (const row of rows) {
      const locked = tx
        .update(metricSchedule)
        .set({ lockedBy: worker, lockedAt: now, updatedAt: now })
        .where(
          and(
            eq(metricSchedule.postKey, row.postKey),
            eq(metricSchedule.target, row.target),
            or(isNull(metricSchedule.lockedBy), isNull(metricSchedule.lockedAt), lt(metricSchedule.lockedAt, cutoff)),
          ),
        )
        .returning({ postKey: metricSchedule.postKey })
        .get();
      if (!locked) continue;
      claimed.push({
        postKey: row.postKey,
        target: row.target,
        checkCount: row.checkCount,
        messageId: row.messageId,
        dateUtc: row.dateUtc,
        externalId: row.externalId,
        externalIds: row.externalIds ?? (row.externalId ? [row.externalId] : []),
        url: row.url,
        lockId: worker,
      });
    }
  });
  return claimed;
}

export function finishMetricTask(
  backendDb: BackendDb,
  task: MetricTask,
  error: string | null,
  terminal = false,
  db = unsafeDb(backendDb).db,
): void {
  const now = new Date();
  const nextIndex = error ? task.checkCount : task.checkCount + 1;
  const nextCheckpoint = terminal ? null : error ? new Date(now.getTime() + 15 * 60_000) : metricCheckpointAt(task.dateUtc, nextIndex, now);
  db.update(metricSchedule)
    .set({
      nextCheckAt: nextCheckpoint?.toISOString() ?? null,
      lastCheckedAt: now.toISOString(),
      checkCount: error ? task.checkCount : sql`${metricSchedule.checkCount} + 1`,
      frozenAt: nextCheckpoint == null ? now.toISOString() : null,
      lastError: error,
      lockedBy: null,
      lockedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(and(eq(metricSchedule.postKey, task.postKey), eq(metricSchedule.target, task.target), eq(metricSchedule.lockedBy, task.lockId)))
    .run();
}

/**
 * Retires schedules whose target no longer has a collector at all — targets removed
 * from the catalogue keep rows that can never be checked, and before they were frozen
 * they stayed permanently overdue and counted as backlog. Paid targets are exempt:
 * they are switched by `ENABLE_X_METRICS`, so freezing them here would retire a target
 * that is merely turned off today. Pass the statically supported set, never the
 * credential-dependent one, so a missing token cannot retire a live schedule.
 */
export function freezeUnsupportedMetricSchedules(backendDb: BackendDb, supported: readonly string[]): void {
  if (supported.length === 0) return;
  const now = new Date().toISOString();
  unsafeDb(backendDb)
    .db.update(metricSchedule)
    .set({ frozenAt: now, nextCheckAt: null, lastError: null, updatedAt: now })
    .where(and(isNull(metricSchedule.frozenAt), notInArray(metricSchedule.target, [...supported, ...PAID_METRIC_TARGETS])))
    .run();
}

export function freezeDisabledMetricSchedules(backendDb: BackendDb, targets: readonly string[]): void {
  if (targets.length === 0) return;
  const now = new Date().toISOString();
  unsafeDb(backendDb)
    .db.update(metricSchedule)
    .set({ frozenAt: now, nextCheckAt: null, lastError: null, updatedAt: now })
    .where(and(isNull(metricSchedule.frozenAt), inArray(metricSchedule.target, [...targets])))
    .run();
}

function parseDate(value: string | null): Date {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
