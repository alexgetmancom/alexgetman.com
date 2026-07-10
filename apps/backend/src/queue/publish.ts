import os from "node:os";
import process from "node:process";
import * as z from "zod";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { classifyPublishError, nextRetryAt, normalizePublishResult, type PublishResult } from "./errors.js";

export type ClaimedPublishJob = {
  jobId: number;
  postId: number | null;
  postKey: string;
  messageId: number;
  target: string;
  payload: Record<string, unknown>;
  attemptCount: number;
};

export function workerId(prefix = "backend"): string {
  return `${prefix}:${os.hostname()}:${process.pid}`;
}

export function claimDuePublishJobs(backendDb: BackendDb, limit: number, worker = workerId()): ClaimedPublishJob[] {
  const now = new Date().toISOString();
  const rows = backendDb.sqlite
    .prepare(
      `SELECT *
       FROM publish_jobs
       WHERE status='queued'
         AND (publish_at IS NULL OR publish_at <= ?)
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at, job_id
       LIMIT ?`,
    )
    .all(now, now, limit) as Record<string, unknown>[];

  const claimed: ClaimedPublishJob[] = [];
  const update = backendDb.sqlite.prepare(
    `UPDATE publish_jobs
     SET status='publishing', locked_by=?, locked_at=?, updated_at=?
     WHERE job_id=? AND status='queued'`,
  );
  const markTarget = backendDb.sqlite.prepare(
    `INSERT INTO post_targets(post_key, target, status, error, skipped, updated_at, raw_json)
     VALUES (?, ?, 'publishing', NULL, 0, ?, ?)
     ON CONFLICT(post_key, target) DO UPDATE SET
       status='publishing',
       error=NULL,
       skipped=0,
       updated_at=excluded.updated_at,
       raw_json=excluded.raw_json`,
  );

  backendDb.sqlite.transaction(() => {
    for (const row of rows) {
      const jobId = Number(row.job_id);
      const result = update.run(worker, now, now, jobId);
      if (result.changes !== 1) continue;
      const postKey = jobPostKey(row);
      markTarget.run(postKey, String(row.target), now, JSON.stringify({ job_id: jobId, worker }));
      insertEvent(backendDb, postKey, String(row.target), "publish.job.claimed", "info", `Publishing ${String(row.target)}`, {
        job_id: jobId,
        worker,
      });
      claimed.push({
        jobId,
        postId: row.post_id == null ? null : Number(row.post_id),
        postKey,
        messageId: Number(row.message_id),
        target: String(row.target),
        payload: parsePayload(row.payload_json),
        attemptCount: Number(row.attempt_count ?? 0),
      });
    }
  })();
  return claimed;
}

export function recoverStalePublishJobs(backendDb: BackendDb, timeoutSeconds: number): number {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const result = backendDb.sqlite
    .prepare(
      `UPDATE publish_jobs
       SET status='queued', locked_by=NULL, locked_at=NULL, next_attempt_at=?, updated_at=?, last_error=COALESCE(last_error, 'stale publish lock recovered')
       WHERE status='publishing' AND locked_at IS NOT NULL AND locked_at < ?`,
    )
    .run(now, now, cutoff);
  return result.changes;
}

export function completePublishJob(backendDb: BackendDb, jobId: number, result: PublishResult): void {
  const now = new Date().toISOString();
  const job = backendDb.sqlite.prepare("SELECT * FROM publish_jobs WHERE job_id=?").get(jobId) as Record<string, unknown> | undefined;
  if (!job) return;
  const postKey = jobPostKey(job);
  const normalized = normalizePublishResult(result);
  backendDb.sqlite.transaction(() => {
    backendDb.sqlite
      .prepare(
        `INSERT INTO post_targets(post_key, target, status, external_id, external_ids_json, url, error, skipped, updated_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_key, target) DO UPDATE SET
           status=excluded.status,
           external_id=CASE WHEN excluded.status='published' THEN excluded.external_id ELSE NULL END,
           external_ids_json=CASE WHEN excluded.status='published' THEN excluded.external_ids_json ELSE NULL END,
           url=CASE WHEN excluded.status='published' THEN excluded.url ELSE NULL END,
           error=excluded.error,
           skipped=excluded.skipped,
           updated_at=excluded.updated_at,
           raw_json=excluded.raw_json`,
      )
      .run(
        postKey,
        String(job.target),
        normalized.status,
        normalized.externalId,
        normalized.externalIds == null ? null : JSON.stringify(normalized.externalIds),
        normalized.url,
        normalized.error,
        normalized.skipped,
        now,
        normalized.rawJson,
      );
    backendDb.sqlite
      .prepare("UPDATE publish_jobs SET status=?, locked_by=NULL, locked_at=NULL, last_error=?, updated_at=? WHERE job_id=?")
      .run(normalized.status, normalized.error, now, jobId);
    backendDb.sqlite
      .prepare(
        "DELETE FROM publish_jobs WHERE target=? AND job_id<>? AND status IN ('queued','failed') AND (post_key=? OR (post_key IS NULL AND message_id=?))",
      )
      .run(String(job.target), jobId, postKey, Number(job.message_id));
    if (String(job.target) === "telegram" && normalized.status === "published" && normalized.externalId && job.post_id != null) {
      const messageId = Number(normalized.externalId);
      backendDb.sqlite
        .prepare("UPDATE publications SET telegram_message_id=?, updated_at=? WHERE post_id=?")
        .run(messageId, now, Number(job.post_id));
      backendDb.sqlite
        .prepare("UPDATE drafts SET channel_message_id=?, updated_at=? WHERE post_id=?")
        .run(messageId, now, Number(job.post_id));
      backendDb.sqlite
        .prepare("UPDATE posts SET message_id=?, telegram_url=?, updated_at=? WHERE post_key=?")
        .run(messageId, normalized.url, now, postKey);
    }
    insertEvent(
      backendDb,
      postKey,
      String(job.target),
      `publish.job.${normalized.status}`,
      normalized.status === "failed" ? "error" : "info",
      `${String(job.target)} ${normalized.status}`,
      {
        job_id: jobId,
        result,
      },
    );
  })();
  if (job.post_id != null) reconcilePublication(backendDb, Number(job.post_id));
}

export function failPublishJob(backendDb: BackendDb, config: BackendConfig, jobId: number, error: unknown): void {
  const now = new Date().toISOString();
  const job = backendDb.sqlite.prepare("SELECT * FROM publish_jobs WHERE job_id=?").get(jobId) as Record<string, unknown> | undefined;
  if (!job) return;
  const postKey = jobPostKey(job);
  const attempt = Number(job.attempt_count ?? 0) + 1;
  const errorClass = classifyPublishError(error);
  const shouldRetry = (errorClass === "transient" && attempt < config.PUBLISH_MAX_ATTEMPTS) || (errorClass === "unknown" && attempt < 2);
  const status = shouldRetry ? "queued" : "failed";
  const nextAttempt = shouldRetry ? nextRetryAt(attempt, config.PUBLISH_BACKOFF_BASE_SECONDS, config.PUBLISH_BACKOFF_MAX_SECONDS) : null;
  const errorText = String(error instanceof Error ? error.message : error);
  backendDb.sqlite.transaction(() => {
    backendDb.sqlite
      .prepare(
        "UPDATE publish_jobs SET status=?, attempt_count=?, next_attempt_at=?, locked_by=NULL, locked_at=NULL, last_error=?, updated_at=? WHERE job_id=?",
      )
      .run(status, attempt, nextAttempt, errorText, now, jobId);
    if (!shouldRetry)
      backendDb.sqlite
        .prepare(
          "DELETE FROM publish_jobs WHERE target=? AND job_id<>? AND status IN ('queued','failed') AND (post_key=? OR (post_key IS NULL AND message_id=?))",
        )
        .run(String(job.target), jobId, postKey, Number(job.message_id));
    backendDb.sqlite
      .prepare(
        `INSERT INTO post_targets(post_key, target, status, error, skipped, updated_at, raw_json)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(post_key, target) DO UPDATE SET
           status=excluded.status,
           error=excluded.error,
           skipped=0,
           updated_at=excluded.updated_at,
           raw_json=excluded.raw_json`,
      )
      .run(
        postKey,
        String(job.target),
        status,
        errorText,
        now,
        JSON.stringify({ job_id: jobId, error_class: errorClass, attempt, next_attempt_at: nextAttempt }),
      );
    insertEvent(
      backendDb,
      postKey,
      String(job.target),
      shouldRetry ? "publish.job.retry" : "publish.job.failed",
      shouldRetry ? "warn" : "error",
      errorText,
      {
        job_id: jobId,
        error_class: errorClass,
        attempt,
        next_attempt_at: nextAttempt,
      },
    );
  })();
  if (!shouldRetry && job.post_id != null) reconcilePublication(backendDb, Number(job.post_id));
}

export function reconcilePublication(backendDb: BackendDb, postId: number): void {
  const social = backendDb.sqlite
    .prepare(
      `SELECT
       SUM(CASE WHEN status IN ('queued','publishing') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
     FROM publish_jobs WHERE post_id=?`,
    )
    .get(postId) as { pending: number | null; failed: number | null };
  const site = backendDb.sqlite
    .prepare(
      `SELECT
       SUM(CASE WHEN status IN ('queued','rendering') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
     FROM site_jobs WHERE post_id=?`,
    )
    .get(postId) as { pending: number | null; failed: number | null };
  if (Number(social.pending ?? 0) + Number(site.pending ?? 0) > 0) return;
  const status = Number(social.failed ?? 0) + Number(site.failed ?? 0) > 0 ? "failed" : "published";
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    backendDb.sqlite.prepare("UPDATE publications SET status=?, updated_at=? WHERE post_id=?").run(status, now, postId);
    backendDb.sqlite.prepare("UPDATE drafts SET status=?, updated_at=? WHERE post_id=?").run(status, now, postId);
  })();
}

export function enqueuePublishJob(
  backendDb: BackendDb,
  input: {
    messageId: number;
    target: string;
    payload: Record<string, unknown>;
    postId?: number | null;
    postKey?: string | null;
    publishAt?: string | null;
  },
): number {
  const now = new Date().toISOString();
  const postKey = input.postKey ?? (input.postId != null ? `post:${input.postId}` : `telegram:alexgetmancom:${input.messageId}`);
  const result = backendDb.sqlite
    .prepare(
      `INSERT INTO publish_jobs(post_id, post_key, message_id, target, status, publish_at, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    )
    .run(input.postId ?? null, postKey, input.messageId, input.target, input.publishAt ?? null, JSON.stringify(input.payload), now, now);
  return Number(result.lastInsertRowid);
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function jobPostKey(row: Record<string, unknown>): string {
  if (row.post_key) return String(row.post_key);
  if (row.post_id) return `post:${Number(row.post_id)}`;
  return `telegram:alexgetmancom:${Number(row.message_id)}`;
}

function insertEvent(
  backendDb: BackendDb,
  postKey: string | null,
  target: string | null,
  eventType: string,
  severity: string,
  message: string,
  details: Record<string, unknown>,
): void {
  backendDb.sqlite
    .prepare(
      "INSERT INTO post_events(post_key, event_type, severity, target, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(postKey, eventType, severity, target, message, JSON.stringify(details), new Date().toISOString());
}
