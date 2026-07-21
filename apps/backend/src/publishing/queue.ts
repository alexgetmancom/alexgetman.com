import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";
import { and, eq, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import * as z from "zod";
import type { BackendDb } from "../db/client.js";
import { drafts, type JsonObject, postEvents, postTargets, publications, publishJobs, siteJobs } from "../db/schema.js";
import { insertPublishJobSchema } from "../db/validation.js";
import type { BackendConfig } from "../foundation/config.js";
import { recordAuthFailure, recordAuthSuccess } from "../observability/auth-circuit.js";
import { classifyPublishError, normalizePublishResult, type PublishResult } from "./errors.js";
import { failedJobTransition, reconciliationTransition } from "./job-policy.js";
import { publicationStatus } from "./state.js";

export type ClaimedPublishJob = {
  jobId: number;
  postId: number | null;
  postKey: string;
  messageId: number;
  target: string;
  payload: JsonObject;
  attemptCount: number;
  lockId: string;
};

export function workerId(prefix = "backend"): string {
  return `${prefix}:${os.hostname()}:${process.pid}`;
}

export function claimDuePublishJobs(
  backendDb: BackendDb,
  limit: number,
  worker = `${workerId()}:${crypto.randomUUID()}`,
): ClaimedPublishJob[] {
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
      upsertPostTarget(tx, {
        postKey,
        target: row.target,
        status: "publishing",
        error: null,
        skipped: 0,
        updatedAt: now,
        rawJson: JSON.stringify({ job_id: row.jobId, worker }),
      });
      insertEvent(tx, postKey, row.target, "publish.job.claimed", "info", `Publishing ${row.target}`, { job_id: row.jobId, worker });
      claimed.push({
        jobId: row.jobId,
        postId: row.postId,
        postKey,
        messageId: row.messageId,
        target: row.target,
        payload: parsePayload(row.payloadJson),
        attemptCount: row.attemptCount,
        lockId: worker,
      });
    }
  });
  return claimed;
}

export function recoverStalePublishJobs(backendDb: BackendDb, config: BackendConfig): number {
  const cutoff = new Date(Date.now() - config.PUBLISH_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();
  const stale = backendDb.db
    .select()
    .from(publishJobs)
    .where(and(eq(publishJobs.status, "publishing"), lt(publishJobs.lockedAt, cutoff)))
    .all();
  backendDb.db.transaction((tx) => {
    for (const job of stale) {
      const lockedAt = job.lockedAt;
      if (!lockedAt) continue;
      const error = job.lastError || "worker_lost: publishing lock expired before completion";
      const transition = failedJobTransition(new Error(error), job.attemptCount, publishRetryPolicy(config));
      const updated = tx
        .update(publishJobs)
        .set({
          status: transition.status,
          attemptCount: transition.attempt,
          lockedBy: null,
          lockedAt: null,
          nextAttemptAt: transition.nextAttemptAt,
          updatedAt: now,
          lastError: error,
        })
        .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing"), eq(publishJobs.lockedAt, lockedAt)))
        .returning({ jobId: publishJobs.jobId })
        .get();
      if (!updated) continue;
      const postKey = jobPostKey(job);
      settleJob(
        tx,
        job.jobId,
        null,
        postKey,
        job.target,
        {
          status: transition.status,
          error,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify({ job_id: job.jobId, recovered_stale_lock: true }),
        },
        {
          type: transition.status === "queued" ? "publish.job.retry" : "publish.job.failed",
          severity: transition.status === "queued" ? "warn" : "error",
          message: error,
          details: {
            job_id: job.jobId,
            recovered_stale_lock: true,
            error_class: transition.errorClass,
            attempt: transition.attempt,
            next_attempt_at: transition.nextAttemptAt,
          },
        },
      );
    }
  });
  for (const job of stale) if (job.postId != null) reconcilePublication(backendDb, job.postId);
  return stale.length;
}

export function completePublishJob(
  backendDb: BackendDb,
  config: BackendConfig,
  jobId: number,
  result: PublishResult,
  lockId?: string,
): void {
  const now = new Date().toISOString();
  const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
  if (!job || (lockId != null && (job.status !== "publishing" || job.lockedBy !== lockId))) return;
  const postKey = jobPostKey(job);
  // Threads partial-publish and generic reconciliation both resume from a set of
  // external ids on the next attempt; they only differ in which payload key the
  // platform's publisher reads back and in the event type recorded.
  if (result.partial && job.target.startsWith("threads")) {
    const ids = Array.isArray(result.ids) ? result.ids.map(String).filter(Boolean) : [];
    const retry = settleRetryableIds(
      backendDb,
      config,
      job,
      jobId,
      postKey,
      ids,
      "_threadsPublishedIds",
      "publish.job.partial",
      "Threads partial publication",
      result,
      now,
    );
    if (!retry && job.postId != null) reconcilePublication(backendDb, job.postId);
    return;
  }
  const reconciliationIds = externalIds(result);
  if (result.retryable && !result.ok && !result.skipped && reconciliationIds.length > 0) {
    const retry = settleRetryableIds(
      backendDb,
      config,
      job,
      jobId,
      postKey,
      reconciliationIds,
      "_reconcile_ids",
      "publish.job.reconcile",
      "external publication requires reconciliation",
      result,
      now,
    );
    if (!retry && job.postId != null) reconcilePublication(backendDb, job.postId);
    return;
  }
  const normalized = normalizePublishResult(result);
  backendDb.db.transaction((tx) => {
    const published = normalized.status === "published";
    // `post_targets` is the canonical external-publication reference for every
    // platform. Legacy Telegram message columns remain readable for history,
    // but new delivery results never mutate the domain model for one platform.
    settleJob(
      tx,
      jobId,
      { status: normalized.status, lockedBy: null, lockedAt: null, lastError: normalized.error, updatedAt: now },
      postKey,
      job.target,
      {
        status: normalized.status,
        externalId: published ? normalized.externalId : null,
        externalIdsJson: published && normalized.externalIds != null ? normalized.externalIds.map(String) : null,
        url: published ? normalized.url : null,
        error: normalized.error,
        skipped: normalized.skipped,
        updatedAt: now,
        rawJson: normalized.rawJson,
      },
      {
        type: `publish.job.${normalized.status}`,
        severity: normalized.status === "failed" ? "error" : "info",
        message: `${job.target} ${normalized.status}`,
        details: { job_id: jobId, result },
      },
    );
    deleteSupersededJobs(tx, job, jobId, postKey);
  });
  if (normalized.status === "published") recordAuthSuccess(backendDb, job.target);
  else if (normalized.status === "failed" && classifyPublishError(normalized.error) === "auth") recordAuthFailure(backendDb, job.target);
  if (job.postId != null) reconcilePublication(backendDb, job.postId);
}

function settleRetryableIds(
  backendDb: BackendDb,
  config: BackendConfig,
  job: typeof publishJobs.$inferSelect,
  jobId: number,
  postKey: string,
  ids: string[],
  payloadKey: "_threadsPublishedIds" | "_reconcile_ids",
  retryEventType: string,
  fallbackError: string,
  result: PublishResult,
  now: string,
): boolean {
  const { attempt, status, nextAttemptAt } = reconciliationTransition(job.attemptCount, publishRetryPolicy(config));
  const retry = status === "queued";
  const error = String(result.error ?? fallbackError);
  const payload = { ...parsePayload(job.payloadJson), [payloadKey]: ids };
  backendDb.db.transaction((tx) => {
    settleJob(
      tx,
      jobId,
      {
        status,
        attemptCount: attempt,
        nextAttemptAt,
        lockedBy: null,
        lockedAt: null,
        payloadJson: payload,
        lastError: error,
        updatedAt: now,
      },
      postKey,
      job.target,
      { status, externalId: ids[0] ?? null, externalIdsJson: ids, error, skipped: 0, updatedAt: now, rawJson: JSON.stringify(result) },
      {
        type: retry ? retryEventType : "publish.job.failed",
        severity: retry ? "warn" : "error",
        message: error,
        details: { job_id: jobId, ids, attempt, next_attempt_at: nextAttemptAt },
      },
    );
  });
  return retry;
}

export function failPublishJob(backendDb: BackendDb, config: BackendConfig, jobId: number, error: unknown, lockId?: string): void {
  const now = new Date().toISOString();
  const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.jobId, jobId)).get();
  if (!job || (lockId != null && (job.status !== "publishing" || job.lockedBy !== lockId))) return;
  const postKey = jobPostKey(job);
  const {
    attempt,
    errorClass,
    status,
    nextAttemptAt: nextAttempt,
  } = failedJobTransition(error, job.attemptCount, publishRetryPolicy(config));
  const shouldRetry = status === "queued";
  const errorText = String(error instanceof Error ? error.message : error);
  backendDb.db.transaction((tx) => {
    settleJob(
      tx,
      jobId,
      { status, attemptCount: attempt, nextAttemptAt: nextAttempt, lockedBy: null, lockedAt: null, lastError: errorText, updatedAt: now },
      postKey,
      job.target,
      {
        status,
        error: errorText,
        skipped: 0,
        updatedAt: now,
        rawJson: JSON.stringify({ job_id: jobId, error_class: errorClass, attempt, next_attempt_at: nextAttempt }),
      },
      {
        type: shouldRetry ? "publish.job.retry" : "publish.job.failed",
        severity: shouldRetry ? "warn" : "error",
        message: errorText,
        details: { job_id: jobId, error_class: errorClass, attempt, next_attempt_at: nextAttempt },
      },
    );
    if (!shouldRetry) deleteSupersededJobs(tx, job, jobId, postKey);
  });
  if (errorClass === "auth") recordAuthFailure(backendDb, job.target);
  if (!shouldRetry && job.postId != null) reconcilePublication(backendDb, job.postId);
}

function publishRetryPolicy(config: BackendConfig) {
  return {
    maxAttempts: config.PUBLISH_MAX_ATTEMPTS,
    backoffBaseSeconds: config.PUBLISH_BACKOFF_BASE_SECONDS,
    backoffMaxSeconds: config.PUBLISH_BACKOFF_MAX_SECONDS,
  };
}

export function reconcilePublication(backendDb: BackendDb, postId: number): void {
  const existing = backendDb.db.select({ status: publications.status }).from(publications).where(eq(publications.postId, postId)).get();
  if (existing?.status === "cancelled") return;
  const social = backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.postId, postId)).all();
  const site = backendDb.db.select({ status: siteJobs.status }).from(siteJobs).where(eq(siteJobs.postId, postId)).all();
  const all = [...social, ...site];
  const status = publicationStatus(all.map((job) => job.status));
  if (!status) return;
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    tx.update(publications).set({ status, updatedAt: now }).where(eq(publications.postId, postId)).run();
    tx.update(drafts).set({ status, updatedAt: now }).where(eq(drafts.postId, postId)).run();
  });
}

export function enqueuePublishJobTx(db: BackendDb["db"], input: EnqueuePublishJobInput): number {
  const now = new Date().toISOString();
  const inputRecord = {
    postId: input.postId,
    postKey: input.postKey,
    messageId: input.messageId,
    target: input.target,
    status: "queued",
    publishAt: input.publishAt ?? null,
    payloadJson: input.payload,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof publishJobs.$inferInsert;
  insertPublishJobSchema.parse(inputRecord);
  const inserted = db.insert(publishJobs).values(inputRecord).returning({ jobId: publishJobs.jobId }).get();
  if (!inserted) throw new Error("publish job insert did not return an id");
  return inserted.jobId;
}

type EnqueuePublishJobInput = {
  messageId: number;
  target: string;
  payload: JsonObject;
  postId: number;
  postKey: string;
  publishAt?: string | null;
};

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

function parsePayload(value: JsonObject | null): JsonObject {
  const parsed = z.record(z.string(), z.json()).safeParse(value);
  return parsed.success ? parsed.data : {};
}

function externalIds(result: PublishResult): string[] {
  const ids = Array.isArray(result.ids) ? result.ids.map(String).filter(Boolean) : [];
  if (ids.length > 0) return [...new Set(ids)];
  return result.id == null ? [] : [String(result.id)];
}

/** Every current write sets postKey directly (see enqueuePublishJobTx); this
 * fallback only covers pre-existing rows from before that was mandatory. */
function jobPostKey(job: Pick<typeof publishJobs.$inferSelect, "postKey" | "postId">): string {
  return job.postKey ?? `post:${job.postId}`;
}

/** Keeps target state updates consistent across claim, completion, and recovery paths. */
function upsertPostTarget(db: BackendDb["db"], value: typeof postTargets.$inferInsert): void {
  const { postKey, target, ...patch } = value;
  db.insert(postTargets)
    .values(value)
    .onConflictDoUpdate({ target: [postTargets.postKey, postTargets.target], set: patch })
    .run();
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

/** Every job-settling path (claim recovery, completion, failure, reconciliation) updates
 * the job row, mirrors the target's state, and logs the transition as one unit. */
function settleJob(
  tx: BackendDb["db"],
  jobId: number,
  jobPatch: Partial<typeof publishJobs.$inferInsert> | null,
  postKey: string,
  target: string,
  targetPatch: Omit<typeof postTargets.$inferInsert, "postKey" | "target">,
  event: { type: string; severity: string; message: string; details: Record<string, unknown> },
): void {
  if (jobPatch) tx.update(publishJobs).set(jobPatch).where(eq(publishJobs.jobId, jobId)).run();
  upsertPostTarget(tx, { postKey, target, ...targetPatch });
  insertEvent(tx, postKey, target, event.type, event.severity, event.message, event.details);
}
