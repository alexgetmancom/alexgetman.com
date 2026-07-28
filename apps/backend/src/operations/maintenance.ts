import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import { freezeDisabledMetricSchedules } from "../analytics/collection/metric-schedule.js";
import type { BackendDb } from "../db/client.js";
import {
  deploymentSnapshots,
  drafts,
  maintenanceLocks,
  metricSchedule,
  postEvents,
  posts,
  postTargets,
  publications,
  publishJobs,
  videoDrafts,
  videoTargets,
} from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { publicationStatus } from "../publishing/state.js";

/** Explicitly invoked operational maintenance routines. */
export async function backupDatabase(backendDb: BackendDb, sourcePath: string, destinationDirectory?: string): Promise<string> {
  if (sourcePath === ":memory:") throw new Error("cannot back up an in-memory database");
  const directory = destinationDirectory ?? path.join(path.dirname(sourcePath), "backups");
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const destination = path.join(directory, `${path.basename(sourcePath, path.extname(sourcePath))}-${stamp}.db`);
  await backendDb.sqlite.backup(destination);
  backendDb.db
    .insert(deploymentSnapshots)
    .values({ action: "backup", status: "ok", backupPath: destination, createdAt: new Date().toISOString() })
    .run();
  return destination;
}

export function restoreDatabase(source: string, destination: string, force: boolean): void {
  if (!force) throw new Error("restore requires --force");
  if (!fs.existsSync(source)) throw new Error(`backup does not exist: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${destination}${suffix}`, { force: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
}

export function buildMetricsBackfillPlan(
  backendDb: BackendDb,
  options: { targets: string[]; refs?: string[]; dateFrom?: string; dateTo?: string },
): Record<string, unknown>[] {
  if (options.targets.length === 0) return [];
  const conditions = [eq(posts.status, "active"), eq(postTargets.status, "published"), inArray(postTargets.target, options.targets)];
  if (options.refs?.length) conditions.push(inArray(posts.postKey, options.refs));
  if (options.dateFrom) conditions.push(gte(posts.dateUtc, options.dateFrom));
  if (options.dateTo) conditions.push(lte(posts.dateUtc, options.dateTo));
  return backendDb.db
    .select({
      postKey: posts.postKey,
      postId: posts.postId,
      messageId: posts.messageId,
      dateUtc: posts.dateUtc,
      target: postTargets.target,
    })
    .from(posts)
    .innerJoin(postTargets, eq(postTargets.postKey, posts.postKey))
    .where(and(...conditions))
    .orderBy(desc(posts.dateUtc), postTargets.target)
    .all();
}

export function applyMetricsBackfill(
  backendDb: BackendDb,
  config: BackendConfig,
  rows: Record<string, unknown>[],
  resetCounts = false,
): number {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    for (const row of rows) {
      const postKey = typeof row.postKey === "string" ? row.postKey : "";
      const target = typeof row.target === "string" ? row.target : "";
      if (!postKey || !target) continue;
      tx.insert(metricSchedule)
        .values({ postKey, target, nextCheckAt: null, checkCount: 0, frozenAt: null, lastError: null, updatedAt: now })
        .onConflictDoUpdate({
          target: [metricSchedule.postKey, metricSchedule.target],
          set: { nextCheckAt: null, ...(resetCounts ? { checkCount: 0 } : {}), frozenAt: null, lastError: null, updatedAt: now },
        })
        .run();
    }
  });
  // A backfill must not resurrect targets this Studio has deliberately kept
  // paid-metrics disabled for; follow the same config-driven list the regular
  // metrics cycle uses instead of a hardcoded platform pair.
  freezeDisabledMetricSchedules(backendDb, [...(config.ENABLE_X_METRICS ? [] : ["x", "twitter"])]);
  return rows.length;
}

export function auditOperations(backendDb: BackendDb): Record<string, unknown> {
  return {
    postEventsByType: backendDb.db
      .select({
        severity: postEvents.severity,
        eventType: postEvents.eventType,
        count: sql<number>`count(*)`,
        latest: sql<string | null>`max(${postEvents.createdAt})`,
      })
      .from(postEvents)
      .groupBy(postEvents.severity, postEvents.eventType)
      .orderBy(postEvents.severity, postEvents.eventType)
      .all(),
    recentPostEvents: backendDb.db
      .select({
        severity: postEvents.severity,
        eventType: postEvents.eventType,
        target: postEvents.target,
        message: postEvents.message,
        createdAt: postEvents.createdAt,
      })
      .from(postEvents)
      .orderBy(desc(postEvents.createdAt))
      .limit(20)
      .all(),
    failedPublishJobs: backendDb.db
      .select({ target: publishJobs.target, count: sql<number>`count(*)`, latest: sql<string | null>`max(${publishJobs.updatedAt})` })
      .from(publishJobs)
      .where(eq(publishJobs.status, "failed"))
      .groupBy(publishJobs.target)
      .orderBy(publishJobs.target)
      .all(),
    failedTargets: backendDb.db
      .select({ target: postTargets.target, count: sql<number>`count(*)`, latest: sql<string | null>`max(${postTargets.updatedAt})` })
      .from(postTargets)
      .where(eq(postTargets.status, "failed"))
      .groupBy(postTargets.target)
      .orderBy(postTargets.target)
      .all(),
    publicationConsistency: publicationConsistencyReport(backendDb),
    metricScheduleErrors: backendDb.db
      .select({ target: metricSchedule.target, count: sql<number>`count(*)`, latest: sql<string | null>`max(${metricSchedule.updatedAt})` })
      .from(metricSchedule)
      .where(and(isNull(metricSchedule.frozenAt), isNotNull(metricSchedule.lastError), sql`${metricSchedule.lastError} != ''`))
      .groupBy(metricSchedule.target)
      .orderBy(metricSchedule.target)
      .all(),
    // Only actionable delivery failures belong here. Cancelled targets and
    // unfinished/deleted drafts are lifecycle history, not production noise.
    recentVideoFailures: backendDb.db
      .select({
        videoDraftId: videoTargets.videoDraftId,
        label: videoDrafts.label,
        target: videoTargets.target,
        status: videoTargets.status,
        lastError: videoTargets.lastError,
        scheduledAt: videoTargets.scheduledAt,
        updatedAt: videoTargets.updatedAt,
      })
      .from(videoTargets)
      .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
      .where(and(eq(videoTargets.status, "failed"), notInArray(videoDrafts.status, ["draft", "editing", "cancelled"])))
      .orderBy(desc(videoTargets.updatedAt))
      .limit(20)
      .all(),
  };
}

type LatestPublishJob = {
  post_key: string;
  target: string;
  status: string;
  last_error: string | null;
};

export function publicationConsistencyReport(backendDb: BackendDb): Record<string, unknown> {
  const foreignKeyViolations = backendDb.sqlite.query("PRAGMA foreign_key_check").all();
  const staleTargets = backendDb.sqlite
    .query(
      `SELECT t.post_key,t.target,t.status,t.error,t.updated_at
       FROM post_targets t
       WHERE t.status IN ('queued','publishing')
         AND NOT EXISTS (
           SELECT 1 FROM publish_jobs j
           WHERE j.post_key=t.post_key AND j.target=t.target AND j.status IN ('queued','publishing')
         )
       ORDER BY t.updated_at`,
    )
    .all();
  const targetMismatches = targetStateMismatches(backendDb);
  const publicationMismatches = publicationStateMismatches(backendDb);
  const videoDraftMismatches = backendDb.sqlite
    .query(
      `SELECT d.id,d.status,group_concat(t.status) AS target_statuses
       FROM video_drafts d JOIN video_targets t ON t.video_draft_id=d.id
       GROUP BY d.id
       HAVING (d.status='published' AND sum(t.status!='published')>0)
          OR (d.status='partial' AND sum(t.status IN ('failed','cancelled'))=0)
          OR (d.status='scheduled' AND sum(t.status NOT IN ('published','failed','cancelled'))=0)
       ORDER BY d.id`,
    )
    .all();
  const videoTargetJobMismatches = backendDb.sqlite
    .query(
      `SELECT t.video_draft_id,t.id AS video_target_id,t.target,t.status AS target_status,
              j.id AS publish_job_id,j.status AS job_status,j.last_error
       FROM video_targets t
       JOIN video_jobs j ON j.video_target_id=t.id AND j.kind='publish'
       WHERE (t.status='published' AND j.status NOT IN ('completed','cancelled'))
          OR (t.status='failed' AND j.status='completed')
       ORDER BY t.video_draft_id,t.id`,
    )
    .all();
  return {
    foreignKeyViolations,
    staleTargets,
    targetMismatches,
    publicationMismatches,
    videoDraftMismatches,
    videoTargetJobMismatches,
  };
}

export function repairPublicationConsistency(backendDb: BackendDb): Record<string, number> {
  const before = publicationConsistencyReport(backendDb);
  const now = new Date().toISOString();
  let deletedOrphans = 0;
  let repairedTargets = 0;
  let repairedPublications = 0;
  backendDb.db.transaction(() => {
    for (const statement of [
      "DELETE FROM social_comments WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
      "DELETE FROM video_metric_snapshots WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
      "DELETE FROM video_metric_schedule WHERE video_target_id NOT IN (SELECT id FROM video_targets) OR video_target_id IN (SELECT id FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts))",
      "DELETE FROM video_jobs WHERE video_draft_id NOT IN (SELECT id FROM video_drafts) OR (video_target_id IS NOT NULL AND video_target_id NOT IN (SELECT id FROM video_targets))",
      "DELETE FROM video_targets WHERE video_draft_id NOT IN (SELECT id FROM video_drafts)",
      "DELETE FROM metric_schedule WHERE post_key NOT IN (SELECT post_key FROM posts)",
      "DELETE FROM post_targets WHERE post_key NOT IN (SELECT post_key FROM posts)",
      "DELETE FROM post_locales WHERE post_id NOT IN (SELECT post_id FROM publications)",
      "DELETE FROM publication_sources WHERE post_id NOT IN (SELECT post_id FROM publications)",
      "DELETE FROM publication_plans WHERE post_id NOT IN (SELECT post_id FROM publications)",
    ])
      deletedOrphans += backendDb.sqlite.run(statement).changes;

    for (const mismatch of targetStateMismatches(backendDb)) {
      const normalized = normalizeArchivedJobStatus(mismatch.job_status);
      const error = normalized === "failed" ? mismatch.last_error : null;
      backendDb.sqlite
        .query(
          `UPDATE post_targets
           SET status=?, error=?, skipped=?, updated_at=?
           WHERE post_key=? AND target=?`,
        )
        .run(normalized, error, normalized === "skipped" || normalized === "cancelled" ? 1 : 0, now, mismatch.post_key, mismatch.target);
      repairedTargets += 1;
    }

    for (const mismatch of publicationStateMismatches(backendDb)) {
      backendDb.db
        .update(publications)
        .set({ status: mismatch.expected, updatedAt: now })
        .where(eq(publications.postId, mismatch.post_id))
        .run();
      backendDb.db.update(drafts).set({ status: mismatch.expected, updatedAt: now }).where(eq(drafts.postId, mismatch.post_id)).run();
      repairedPublications += 1;
    }
  });
  return {
    foreignKeyViolations: Array.isArray(before.foreignKeyViolations) ? before.foreignKeyViolations.length : 0,
    deletedOrphans,
    repairedTargets,
    repairedPublications,
  };
}

function targetStateMismatches(backendDb: BackendDb): Array<LatestPublishJob & { target_status: string; job_status: string }> {
  const rows = backendDb.sqlite
    .query(
      `WITH latest AS (
         SELECT p.post_key,p.target,p.status,p.last_error
         FROM publish_jobs p
         JOIN (
           SELECT post_key,target,max(job_id) AS job_id
           FROM publish_jobs WHERE post_key IS NOT NULL GROUP BY post_key,target
         ) x ON x.job_id=p.job_id
       )
       SELECT t.post_key,t.target,t.status AS target_status,l.status AS job_status,l.last_error
       FROM post_targets t JOIN latest l ON l.post_key=t.post_key AND l.target=t.target
       WHERE t.target NOT IN ('site_ru','site_en')
       ORDER BY t.post_key,t.target`,
    )
    .all() as Array<LatestPublishJob & { target_status: string; job_status: string }>;
  return rows.filter((row) => row.target_status !== normalizeArchivedJobStatus(row.job_status));
}

function publicationStateMismatches(backendDb: BackendDb): Array<{ post_id: number; status: string; expected: "published" | "failed" }> {
  const rows = backendDb.sqlite
    .query(
      `SELECT p.post_id,p.status,
              group_concat(x.status) AS statuses
       FROM publications p
       LEFT JOIN (
         SELECT post_id,status FROM publish_jobs
         UNION ALL
         SELECT post_id,status FROM site_jobs
       ) x ON x.post_id=p.post_id
       GROUP BY p.post_id
       ORDER BY p.post_id`,
    )
    .all() as Array<{ post_id: number; status: string; statuses: string | null }>;
  return rows.flatMap((row) => {
    if (row.status === "cancelled") return [];
    const expected = publicationStatus((row.statuses ?? "").split(",").filter(Boolean).map(normalizeArchivedJobStatus));
    return expected && expected !== row.status ? [{ post_id: row.post_id, status: row.status, expected }] : [];
  });
}

function normalizeArchivedJobStatus(status: string): string {
  return status === "failed_archived" ? "cancelled" : status;
}

export function withMaintenanceLock<T>(backendDb: BackendDb, operation: () => T): T {
  const name = "metrics_maintenance";
  const owner = `${os.hostname()}:${process.pid}`;
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60_000).toISOString();
  backendDb.db.transaction((tx) => {
    tx.delete(maintenanceLocks)
      .where(and(eq(maintenanceLocks.name, name), lt(maintenanceLocks.expiresAt, now.toISOString())))
      .run();
    tx.insert(maintenanceLocks).values({ name, owner, expiresAt: expires, createdAt: now.toISOString() }).onConflictDoNothing().run();
    const row = tx.select({ owner: maintenanceLocks.owner }).from(maintenanceLocks).where(eq(maintenanceLocks.name, name)).get();
    if (!row) throw new Error("maintenance lock could not be acquired");
    if (row.owner !== owner) throw new Error(`maintenance lock is held by ${row.owner}`);
  });
  try {
    return operation();
  } finally {
    backendDb.db
      .delete(maintenanceLocks)
      .where(and(eq(maintenanceLocks.name, name), eq(maintenanceLocks.owner, owner)))
      .run();
  }
}
