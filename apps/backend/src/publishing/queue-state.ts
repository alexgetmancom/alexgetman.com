import { and, eq, inArray, ne } from "drizzle-orm";
import * as z from "zod";
import type { UnsafeBackendDb } from "../db/client.js";
import type { JsonObject } from "../db/schema.js";
import { postEvents, postTargets, publishJobs } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import type { PublishResult } from "./errors.js";

export function publicationConfirmationSource(result: PublishResult): string {
  if (verificationStatus(result) === "verified") return "provider_verify";
  const raw = result.raw && typeof result.raw === "object" ? (result.raw as Record<string, unknown>) : null;
  if (raw && "existingPost" in raw) return "idempotency_replay";
  return "publish_response";
}

export function verificationStatus(result: PublishResult): string | null {
  const verification = result.verification;
  if (!verification || typeof verification !== "object") return null;
  const status = (verification as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

export function durationSince(startedAt: string | null, finishedAt: string): number | null {
  if (!startedAt) return null;
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function publishRetryPolicy(config: BackendConfig) {
  return {
    maxAttempts: config.PUBLISH_MAX_ATTEMPTS,
    backoffBaseSeconds: config.PUBLISH_BACKOFF_BASE_SECONDS,
    backoffMaxSeconds: config.PUBLISH_BACKOFF_MAX_SECONDS,
  };
}

export function deleteSupersededJobs(
  tx: UnsafeBackendDb["db"],
  job: typeof publishJobs.$inferSelect,
  jobId: number,
  postKey: string,
): void {
  tx.delete(publishJobs)
    .where(
      and(
        eq(publishJobs.target, job.target),
        ne(publishJobs.jobId, jobId),
        inArray(publishJobs.status, ["queued", "failed", "verification_required"]),
        eq(publishJobs.postKey, postKey),
      ),
    )
    .run();
}

export function parsePayload(value: JsonObject | null): JsonObject {
  const parsed = z.record(z.string(), z.json()).safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function externalIds(result: PublishResult): string[] {
  const ids = Array.isArray(result.ids) ? result.ids.map(String).filter(Boolean) : [];
  if (ids.length > 0) return [...new Set(ids)];
  return result.id == null ? [] : [String(result.id)];
}

/** Keeps target state updates consistent across claim, completion, and recovery paths. */
export function upsertPostTarget(db: UnsafeBackendDb["db"], value: typeof postTargets.$inferInsert): void {
  const { postKey, target, ...patch } = value;
  db.insert(postTargets)
    .values(value)
    .onConflictDoUpdate({ target: [postTargets.postKey, postTargets.target], set: patch })
    .run();
}

export function insertEvent(
  tx: UnsafeBackendDb["db"],
  postKey: string | null,
  target: string | null,
  eventType: string,
  severity: string,
  message: string,
  details: Record<string, unknown>,
  createdAt: string,
): void {
  tx.insert(postEvents)
    .values({ postKey, eventType, severity, target, message, detailsJson: JSON.stringify(details), createdAt })
    .run();
}

/** Raised when the lease a settlement was fenced by is no longer held, which
 * rolls the whole settlement back: the job belongs to another worker now, and
 * its target row and journal entry must not be written by the previous one. */
export class PublishLockLostError extends Error {
  constructor(readonly jobId: number) {
    super(`publish_job_lock_lost:${jobId}`);
  }
}

/** A settlement updates the job, mirrors target state, and journals the event
 * atomically. `fence` is the lease the caller checked before it called the
 * provider: that check is minutes old by the time a settlement lands, and
 * without carrying it into the write a timed-out worker overwrote the result
 * its replacement had already recorded. */
export function settleJob(
  tx: UnsafeBackendDb["db"],
  jobId: number,
  jobPatch: Partial<typeof publishJobs.$inferInsert> | null,
  postKey: string,
  target: string,
  targetPatch: Omit<typeof postTargets.$inferInsert, "postKey" | "target"> & { updatedAt: string },
  event: { type: string; severity: string; message: string; details: Record<string, unknown> },
  fence?: string,
): void {
  if (jobPatch && fence != null) {
    const updated = tx
      .update(publishJobs)
      .set(jobPatch)
      .where(and(eq(publishJobs.jobId, jobId), eq(publishJobs.lockedBy, fence)))
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!updated) throw new PublishLockLostError(jobId);
  } else if (jobPatch) tx.update(publishJobs).set(jobPatch).where(eq(publishJobs.jobId, jobId)).run();
  upsertPostTarget(tx, { postKey, target, ...targetPatch });
  insertEvent(tx, postKey, target, event.type, event.severity, event.message, event.details, targetPatch.updatedAt);
}
