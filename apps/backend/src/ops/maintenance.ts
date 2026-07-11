import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, lt } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { maintenanceLocks } from "../db/schema.js";

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
  backendDb.sqlite
    .prepare("INSERT INTO deployment_snapshots(action,status,backup_path,created_at) VALUES ('backup','ok',?,?)")
    .run(destination, new Date().toISOString());
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
  const where = ["p.status='active'", "t.status='published'", `t.target IN (${options.targets.map(() => "?").join(",")})`];
  const parameters: unknown[] = [...options.targets];
  if (options.refs?.length) {
    where.push(`p.post_key IN (${options.refs.map(() => "?").join(",")})`);
    parameters.push(...options.refs);
  }
  if (options.dateFrom) {
    where.push("p.date_utc >= ?");
    parameters.push(options.dateFrom);
  }
  if (options.dateTo) {
    where.push("p.date_utc <= ?");
    parameters.push(options.dateTo);
  }
  return backendDb.sqlite
    .prepare(
      `SELECT p.post_key,p.post_id,p.message_id,p.date_utc,t.target FROM posts p JOIN post_targets t ON t.post_key=p.post_key WHERE ${where.join(" AND ")} ORDER BY p.date_utc DESC,t.target`,
    )
    .all(...parameters) as Record<string, unknown>[];
}

export function applyMetricsBackfill(backendDb: BackendDb, rows: Record<string, unknown>[], resetCounts = false): number {
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    for (const row of rows) {
      backendDb.sqlite
        .prepare(`INSERT INTO metric_schedule(post_key,target,next_check_at,check_count,frozen_at,last_error,updated_at)
        VALUES (?,?,NULL,0,NULL,NULL,?) ON CONFLICT(post_key,target) DO UPDATE SET next_check_at=NULL,
        check_count=${resetCounts ? "0" : "metric_schedule.check_count"},frozen_at=NULL,last_error=NULL,updated_at=excluded.updated_at`)
        .run(row.post_key, row.target, now);
    }
    backendDb.sqlite
      .prepare("UPDATE metric_schedule SET frozen_at=?,next_check_at=NULL,updated_at=? WHERE target IN ('x','linkedin')")
      .run(now, now);
  })();
  return rows.length;
}

export function auditOperations(backendDb: BackendDb): Record<string, unknown> {
  return {
    postEventsByType: backendDb.sqlite
      .prepare(
        "SELECT severity,event_type,count(*) AS count,max(created_at) AS latest FROM post_events GROUP BY severity,event_type ORDER BY severity,event_type",
      )
      .all(),
    recentPostEvents: backendDb.sqlite
      .prepare("SELECT severity,event_type,target,message,created_at FROM post_events ORDER BY created_at DESC LIMIT 20")
      .all(),
    failedPublishJobs: backendDb.sqlite
      .prepare(
        "SELECT target,count(*) AS count,max(updated_at) AS latest FROM publish_jobs WHERE status='failed' GROUP BY target ORDER BY target",
      )
      .all(),
    metricScheduleErrors: backendDb.sqlite
      .prepare(
        "SELECT target,count(*) AS count,max(updated_at) AS latest FROM metric_schedule WHERE last_error IS NOT NULL AND last_error != '' GROUP BY target ORDER BY target",
      )
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
