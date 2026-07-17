import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import {
  deploymentSnapshots,
  maintenanceLocks,
  metricSchedule,
  postEvents,
  posts,
  postTargets,
  publishJobs,
  videoDrafts,
  videoTargets,
} from "../db/schema.js";

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

export function applyMetricsBackfill(backendDb: BackendDb, rows: Record<string, unknown>[], resetCounts = false): number {
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
    tx.update(metricSchedule)
      .set({ frozenAt: now, nextCheckAt: null, updatedAt: now })
      .where(inArray(metricSchedule.target, ["x", "linkedin"]))
      .run();
  });
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
    metricScheduleErrors: backendDb.db
      .select({ target: metricSchedule.target, count: sql<number>`count(*)`, latest: sql<string | null>`max(${metricSchedule.updatedAt})` })
      .from(metricSchedule)
      .where(and(isNotNull(metricSchedule.lastError), sql`${metricSchedule.lastError} != ''`))
      .groupBy(metricSchedule.target)
      .orderBy(metricSchedule.target)
      .all(),
    // Video (YouTube Shorts / Instagram Reels) failures live in a separate
    // pipeline from text posts above; without this, "did the video publish"
    // required a hand-written SQL query every time.
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
      .where(inArray(videoTargets.status, ["failed", "cancelled"]))
      .orderBy(desc(videoTargets.updatedAt))
      .limit(20)
      .all(),
  };
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
