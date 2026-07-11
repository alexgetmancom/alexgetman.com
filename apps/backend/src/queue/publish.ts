import os from "node:os";
import process from "node:process";
import { and, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import * as z from "zod";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { drafts, postEvents, posts, postTargets, publications, publishJobs, siteJobs } from "../db/schema.js";
import { insertPublishJobSchema } from "../db/validation.js";
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
  const rows = backendDb.db
    .select()
    .from(publishJobs)
    .where(
      and(
        eq(publishJobs.status, "queued"),
        or(isNull(publishJobs.publishAt), lte(publishJobs.publishAt, now)),
        or(isNull(publishJobs.nextAttemptAt), lte(publishJobs.nextAttemptAt, now)),
      ),
    )
    .orderBy(publishJobs.createdAt, publishJobs.jobId)
    .limit(limit)
    .all();
  const claimed: ClaimedPublishJob[] = [];
  backendDb.db.transaction((tx) => {
    for (const row of rows) {
      const locked = tx
        .update(publishJobs)
        .set({ status: "publishing", lockedBy: worker, lockedAt: now, updatedAt: now })
        .where(and(eq(publishJobs.jobId, row.jobId), eq(publishJobs.status, "queued")))
        .returning({ jobId: publishJobs.jobId })
        .get();
      if (!locked) continue;
      const postKey = jobPostKey(row);
      tx.insert(postTargets)
        .values({
          postKey,
          target: row.target,
          status: "publishing",
          error: null,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify({ job_id: row.jobId, worker }),
        })
        .onConflictDoUpdate({
          target: [postTargets.postKey, postTargets.target],
          set: { status: "publishing", error: null, skipped: 0, updatedAt: now, rawJson: JSON.stringify({ job_id: row.jobId, worker }) },
        })
        .run();
      insertEvent(tx, postKey, row.target, "publish.job.claimed", "info", `Publishing ${row.target}`, { job_id: row.jobId, worker });
      claimed.push({
        jobId: row.jobId,
        postId: row.postId,
        postKey,
        messageId: row.messageId,
        target: row.target,
        payload: parsePayload(row.payloadJson),
        attemptCount: row.attemptCount,
      });
    }
  });
  return claimed;
}

export function recoverStalePublishJobs(backendDb: BackendDb, timeoutSeconds: number): number {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  return backendDb.db
    .update(publishJobs)
    .set({
      status: "failed",
      lockedBy: null,
      lockedAt: null,
      nextAttemptAt: null,
      updatedAt: now,
      lastError: sql`coalesce(${publishJobs.lastError}, 'stale publish lock requires manual repair')`,
    })
    .where(and(eq(publishJobs.status, "publishing"), lt(publishJobs.lockedAt, cutoff)))
    .returning({ jobId: publishJobs.jobId })
    .all().length;
}

export function completePublishJob(backendDb: BackendDb, config: BackendConfig, jobId: number, result: PublishResult): void {
  const now = new Date().toISOString();
  const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
  if (!job) return;
  const postKey = jobPostKey(job);
  if (result.partial && job.target.startsWith("threads")) {
    const ids = Array.isArray(result.ids) ? result.ids.map(String).filter(Boolean) : [];
    const attempt = job.attemptCount + 1;
    const retryAt = nextRetryAt(attempt, config.PUBLISH_BACKOFF_BASE_SECONDS, config.PUBLISH_BACKOFF_MAX_SECONDS);
    const payload = { ...parsePayload(job.payloadJson), _threadsPublishedIds: ids };
    const error = String(result.error ?? "Threads partial publication");
    backendDb.db.transaction((tx) => {
      tx.update(publishJobs)
        .set({
          status: "queued",
          attemptCount: attempt,
          nextAttemptAt: retryAt,
          lockedBy: null,
          lockedAt: null,
          payloadJson: JSON.stringify(payload),
          lastError: error,
          updatedAt: now,
        })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      tx.insert(postTargets)
        .values({
          postKey,
          target: job.target,
          status: "queued",
          externalId: ids[0] ?? null,
          externalIdsJson: JSON.stringify(ids),
          error,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify(result),
        })
        .onConflictDoUpdate({
          target: [postTargets.postKey, postTargets.target],
          set: {
            status: "queued",
            externalId: ids[0] ?? null,
            externalIdsJson: JSON.stringify(ids),
            error,
            skipped: 0,
            updatedAt: now,
            rawJson: JSON.stringify(result),
          },
        })
        .run();
      insertEvent(tx, postKey, job.target, "publish.job.partial", "warn", error, { job_id: jobId, ids, retry_at: retryAt });
    });
    return;
  }
  const normalized = normalizePublishResult(result);
  backendDb.db.transaction((tx) => {
    const published = normalized.status === "published";
    tx.insert(postTargets)
      .values({
        postKey,
        target: job.target,
        status: normalized.status,
        externalId: published ? normalized.externalId : null,
        externalIdsJson: published && normalized.externalIds != null ? JSON.stringify(normalized.externalIds) : null,
        url: published ? normalized.url : null,
        error: normalized.error,
        skipped: normalized.skipped,
        updatedAt: now,
        rawJson: normalized.rawJson,
      })
      .onConflictDoUpdate({
        target: [postTargets.postKey, postTargets.target],
        set: {
          status: normalized.status,
          externalId: published ? normalized.externalId : null,
          externalIdsJson: published && normalized.externalIds != null ? JSON.stringify(normalized.externalIds) : null,
          url: published ? normalized.url : null,
          error: normalized.error,
          skipped: normalized.skipped,
          updatedAt: now,
          rawJson: normalized.rawJson,
        },
      })
      .run();
    tx.update(publishJobs)
      .set({ status: normalized.status, lockedBy: null, lockedAt: null, lastError: normalized.error, updatedAt: now })
      .where(eq(publishJobs.jobId, jobId))
      .run();
    deleteSupersededJobs(tx, job, jobId, postKey);
    if (job.target === "telegram" && published && normalized.externalId && job.postId != null) {
      const messageId = Number(normalized.externalId);
      tx.update(publications).set({ telegramMessageId: messageId, updatedAt: now }).where(eq(publications.postId, job.postId)).run();
      tx.update(drafts).set({ channelMessageId: messageId, updatedAt: now }).where(eq(drafts.postId, job.postId)).run();
      tx.update(posts).set({ messageId, telegramUrl: normalized.url, updatedAt: now }).where(eq(posts.postKey, postKey)).run();
    }
    insertEvent(
      tx,
      postKey,
      job.target,
      `publish.job.${normalized.status}`,
      normalized.status === "failed" ? "error" : "info",
      `${job.target} ${normalized.status}`,
      { job_id: jobId, result },
    );
  });
  if (job.postId != null) reconcilePublication(backendDb, job.postId);
}

export function failPublishJob(backendDb: BackendDb, config: BackendConfig, jobId: number, error: unknown): void {
  const now = new Date().toISOString();
  const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
  if (!job) return;
  const postKey = jobPostKey(job);
  const attempt = job.attemptCount + 1;
  const errorClass = classifyPublishError(error);
  const shouldRetry = (errorClass === "transient" && attempt < config.PUBLISH_MAX_ATTEMPTS) || (errorClass === "unknown" && attempt < 2);
  const status = shouldRetry ? "queued" : "failed";
  const nextAttempt = shouldRetry ? nextRetryAt(attempt, config.PUBLISH_BACKOFF_BASE_SECONDS, config.PUBLISH_BACKOFF_MAX_SECONDS) : null;
  const errorText = String(error instanceof Error ? error.message : error);
  backendDb.db.transaction((tx) => {
    tx.update(publishJobs)
      .set({
        status,
        attemptCount: attempt,
        nextAttemptAt: nextAttempt,
        lockedBy: null,
        lockedAt: null,
        lastError: errorText,
        updatedAt: now,
      })
      .where(eq(publishJobs.jobId, jobId))
      .run();
    if (!shouldRetry) deleteSupersededJobs(tx, job, jobId, postKey);
    tx.insert(postTargets)
      .values({
        postKey,
        target: job.target,
        status,
        error: errorText,
        skipped: 0,
        updatedAt: now,
        rawJson: JSON.stringify({ job_id: jobId, error_class: errorClass, attempt, next_attempt_at: nextAttempt }),
      })
      .onConflictDoUpdate({
        target: [postTargets.postKey, postTargets.target],
        set: {
          status,
          error: errorText,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify({ job_id: jobId, error_class: errorClass, attempt, next_attempt_at: nextAttempt }),
        },
      })
      .run();
    insertEvent(
      tx,
      postKey,
      job.target,
      shouldRetry ? "publish.job.retry" : "publish.job.failed",
      shouldRetry ? "warn" : "error",
      errorText,
      { job_id: jobId, error_class: errorClass, attempt, next_attempt_at: nextAttempt },
    );
  });
  if (!shouldRetry && job.postId != null) reconcilePublication(backendDb, job.postId);
}

export function reconcilePublication(backendDb: BackendDb, postId: number): void {
  const social = backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.postId, postId)).all();
  const site = backendDb.db.select({ status: siteJobs.status }).from(siteJobs).where(eq(siteJobs.postId, postId)).all();
  const all = [...social, ...site];
  if (all.some((job) => job.status === "queued" || job.status === "publishing" || job.status === "rendering")) return;
  const status = all.some((job) => job.status === "failed") ? "failed" : "published";
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    tx.update(publications).set({ status, updatedAt: now }).where(eq(publications.postId, postId)).run();
    tx.update(drafts).set({ status, updatedAt: now }).where(eq(drafts.postId, postId)).run();
  });
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
  const record = insertPublishJobSchema.parse({
    postId: input.postId ?? null,
    postKey,
    messageId: input.messageId,
    target: input.target,
    status: "queued",
    publishAt: input.publishAt ?? null,
    payloadJson: JSON.stringify(input.payload),
    createdAt: now,
    updatedAt: now,
  });
  return backendDb.db.insert(publishJobs).values(record).returning({ jobId: publishJobs.jobId }).get()!.jobId;
}

function deleteSupersededJobs(tx: BackendDb["db"], job: typeof publishJobs.$inferSelect, jobId: number, postKey: string): void {
  tx.delete(publishJobs)
    .where(
      and(
        eq(publishJobs.target, job.target),
        ne(publishJobs.jobId, jobId),
        inArray(publishJobs.status, ["queued", "failed"]),
        or(eq(publishJobs.postKey, postKey), and(isNull(publishJobs.postKey), eq(publishJobs.messageId, job.messageId))),
      ),
    )
    .run();
}

function parsePayload(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function jobPostKey(job: Pick<typeof publishJobs.$inferSelect, "postKey" | "postId" | "messageId">): string {
  return job.postKey ?? (job.postId != null ? `post:${job.postId}` : `telegram:alexgetmancom:${job.messageId}`);
}

function insertEvent(
  tx: BackendDb["db"],
  postKey: string | null,
  target: string | null,
  eventType: string,
  severity: string,
  message: string,
  details: Record<string, unknown>,
): void {
  tx.insert(postEvents)
    .values({ postKey, eventType, severity, target, message, detailsJson: JSON.stringify(details), createdAt: new Date().toISOString() })
    .run();
}
