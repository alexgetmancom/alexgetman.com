import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";

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

export function ensureMetricSchedule(backendDb: BackendDb, targets: readonly string[]): number {
  if (targets.length === 0) return 0;
  const placeholders = targets.map(() => "?").join(",");
  const rows = backendDb.sqlite
    .prepare(
      `SELECT p.post_key, p.date_utc, t.target
     FROM posts p JOIN post_targets t ON t.post_key=p.post_key
     WHERE p.status='active' AND t.status='published' AND t.target IN (${placeholders})`,
    )
    .all(...targets) as Array<{ post_key: string; date_utc: string | null; target: string }>;
  const insert = backendDb.sqlite.prepare(
    `INSERT INTO metric_schedule(post_key, target, next_check_at, frozen_at, updated_at)
     VALUES (?, ?, ?, NULL, ?) ON CONFLICT(post_key, target) DO NOTHING`,
  );
  let changes = 0;
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    for (const row of rows) {
      const publishedAt = parseDate(row.date_utc);
      changes += insert.run(row.post_key, row.target, new Date(publishedAt.getTime() + 3_600_000).toISOString(), now).changes;
    }
  })();
  return changes;
}

export function dueMetricTasks(backendDb: BackendDb, config: BackendConfig): MetricTask[] {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT s.post_key, s.target, s.check_count, p.message_id, p.date_utc,
            t.external_id, t.external_ids_json, t.url
     FROM metric_schedule s
     JOIN posts p ON p.post_key=s.post_key
     JOIN post_targets t ON t.post_key=s.post_key AND t.target=s.target
     WHERE s.frozen_at IS NULL AND t.status='published' AND (s.next_check_at IS NULL OR s.next_check_at <= ?)
     ORDER BY p.date_utc DESC, s.check_count ASC LIMIT ?`,
    )
    .all(new Date().toISOString(), config.MAX_METRIC_TASKS_PER_CYCLE) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    postKey: String(row.post_key),
    target: String(row.target),
    checkCount: Number(row.check_count ?? 0),
    messageId: Number(row.message_id),
    dateUtc: stringOrNull(row.date_utc),
    externalId: stringOrNull(row.external_id),
    externalIds: parseIds(row.external_ids_json, row.external_id),
    url: stringOrNull(row.url),
  }));
}

export function finishMetricTask(backendDb: BackendDb, task: MetricTask, error: string | null): void {
  const now = new Date();
  const interval = INTERVALS_MS[task.checkCount];
  backendDb.sqlite
    .prepare(
      `UPDATE metric_schedule SET next_check_at=?, last_checked_at=?, check_count=check_count+1,
       frozen_at=?, last_error=?, updated_at=? WHERE post_key=? AND target=?`,
    )
    .run(
      interval == null ? null : new Date(now.getTime() + interval).toISOString(),
      now.toISOString(),
      interval == null ? now.toISOString() : null,
      error,
      now.toISOString(),
      task.postKey,
      task.target,
    );
}

function parseIds(raw: unknown, fallback: unknown): string[] {
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
    } catch {
      // Fall through to the primary external ID.
    }
  }
  return fallback == null || fallback === "" ? [] : [String(fallback)];
}

function parseDate(value: string | null): Date {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
