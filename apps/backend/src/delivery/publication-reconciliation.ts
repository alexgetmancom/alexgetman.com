import crypto from "node:crypto";
import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postTargets, publishJobs, videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { isTargetAuthBlocked } from "../observability/auth-circuit.js";
import { nextRetryAt } from "../publishing/errors.js";
import { reconcilePublication, workerId } from "../publishing/index.js";
import { refreshVideoDraftStatus } from "../publishing/video-data.js";
import { platformConfig, verifyPlatformPublication } from "./ports/social.js";
import { verifyYouTubeVideo } from "./video-publishers.js";
import { verifyZernioPost } from "./zernio.js";

type ReconciliationResult = { checked: number; resolved: number; unresolved: number; oldestAt: string | null };

/** Resolves only cases backed by a durable provider ID. A missing ID remains
 * visible for an operator; guessing by title or timestamp is not safe enough
 * for a reusable self-hosted default. */
export async function runPublicationReconciliation(
  backendDb: BackendDb,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ReconciliationResult> {
  let checked = 0;
  let resolved = 0;
  const nowIso = new Date().toISOString();
  const reconciliationWorker = `${workerId("reconciliation")}:${crypto.randomUUID()}`;
  const staleBefore = new Date(Date.now() - config.METRIC_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const ordinary = unsafeDb(backendDb)
    .db.select({ job: publishJobs, target: postTargets })
    .from(publishJobs)
    .innerJoin(postTargets, and(eq(postTargets.postKey, publishJobs.postKey), eq(postTargets.target, publishJobs.target)))
    .where(
      and(
        eq(publishJobs.status, "verification_required"),
        lt(publishJobs.reconcileAttemptCount, config.RECONCILE_MAX_ATTEMPTS),
        or(isNull(publishJobs.nextAttemptAt), lte(publishJobs.nextAttemptAt, nowIso)),
        or(isNull(publishJobs.lockedBy), isNull(publishJobs.lockedAt), lt(publishJobs.lockedAt, staleBefore)),
      ),
    )
    .limit(config.PUBLISH_CLAIM_LIMIT)
    .all();
  for (const row of ordinary) {
    const claimed = unsafeDb(backendDb)
      .db.update(publishJobs)
      .set({ lockedBy: reconciliationWorker, lockedAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(publishJobs.jobId, row.job.jobId),
          eq(publishJobs.status, "verification_required"),
          or(isNull(publishJobs.lockedBy), isNull(publishJobs.lockedAt), lt(publishJobs.lockedAt, staleBefore)),
        ),
      )
      .returning({ jobId: publishJobs.jobId })
      .get();
    if (!claimed) continue;
    const job = { ...row.job, lockedBy: reconciliationWorker, lockedAt: nowIso };
    checked += 1;
    const externalId = row.target.externalId;
    if (!externalId || isTargetAuthBlocked(backendDb, row.job.target)) {
      deferOrdinaryReconciliation(backendDb, config, job, reconciliationWorker);
      continue;
    }
    let result: Awaited<ReturnType<typeof verifyPlatformPublication>>;
    try {
      result = await verifyPlatformPublication(
        row.job.target,
        { ok: true, id: externalId, url: row.target.url },
        platformConfig(row.job.target, config),
        fetchImpl,
      );
    } catch {
      deferOrdinaryReconciliation(backendDb, config, job, reconciliationWorker);
      continue;
    }
    const verification = result.verification as { status?: string } | undefined;
    if (verification?.status !== "verified") {
      deferOrdinaryReconciliation(backendDb, config, job, reconciliationWorker);
      continue;
    }
    const now = new Date().toISOString();
    unsafeDb(backendDb).db.transaction((tx) => {
      tx.update(publishJobs)
        .set({ status: "published", currentPhase: null, lockedBy: null, lockedAt: null, lastError: null, updatedAt: now })
        .where(
          and(
            eq(publishJobs.jobId, row.job.jobId),
            eq(publishJobs.status, "verification_required"),
            eq(publishJobs.lockedBy, reconciliationWorker),
          ),
        )
        .run();
      tx.update(postTargets)
        .set({
          status: "published",
          error: null,
          url: typeof result.url === "string" ? result.url : row.target.url,
          publishedAt: row.target.publishedAt ?? now,
          confirmationSource: "provider_verify",
          verifiedAt: now,
          updatedAt: now,
        })
        .where(and(eq(postTargets.postKey, row.target.postKey), eq(postTargets.target, row.target.target)))
        .run();
    });
    if (row.job.postId != null) reconcilePublication(backendDb, row.job.postId);
    recordDomainEvent(backendDb.events, {
      ref: row.target.postKey,
      target: row.target.target,
      type: "publish.job.reconciled",
      severity: "info",
      message: `${row.target.target} publication was confirmed`,
      details: { job_id: row.job.jobId, external_id: externalId, confirmation_source: verification?.status ?? "stored_response" },
    });
    resolved += 1;
  }

  const videos = unsafeDb(backendDb)
    .db.select({ target: videoTargets, draft: videoDrafts, job: videoJobs })
    .from(videoTargets)
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .innerJoin(videoJobs, eq(videoJobs.videoTargetId, videoTargets.id))
    .where(
      and(
        eq(videoTargets.status, "verification_required"),
        eq(videoJobs.status, "verification_required"),
        lt(videoJobs.reconcileAttemptCount, config.RECONCILE_MAX_ATTEMPTS),
        or(isNull(videoJobs.nextAttemptAt), lte(videoJobs.nextAttemptAt, nowIso)),
        or(isNull(videoJobs.lockedBy), isNull(videoJobs.lockedAt), lt(videoJobs.lockedAt, staleBefore)),
      ),
    )
    .limit(config.PUBLISH_CLAIM_LIMIT)
    .all();
  for (const row of videos) {
    const claimed = unsafeDb(backendDb)
      .db.update(videoJobs)
      .set({ lockedBy: reconciliationWorker, lockedAt: nowIso, updatedAt: nowIso })
      .where(
        and(
          eq(videoJobs.id, row.job.id),
          eq(videoJobs.status, "verification_required"),
          or(isNull(videoJobs.lockedBy), isNull(videoJobs.lockedAt), lt(videoJobs.lockedAt, staleBefore)),
        ),
      )
      .returning({ id: videoJobs.id })
      .get();
    if (!claimed) continue;
    const job = { ...row.job, lockedBy: reconciliationWorker, lockedAt: nowIso };
    checked += 1;
    if (isTargetAuthBlocked(backendDb, row.target.target)) {
      deferVideoReconciliation(backendDb, config, job, reconciliationWorker);
      continue;
    }
    // Native Instagram Reels are deliberately absent below. Before media_publish
    // returns, the only durable handle on the target is a *container* ID, and
    // Graph offers no way to find the media a container became. Asking about the
    // container as if it were media would 404 at best. These close via operator.
    let confirmation: { externalId?: string | null; url?: string | null } | null = null;
    try {
      if (row.target.deliveryProvider === "zernio" && row.target.providerPostId) {
        const verified = await verifyZernioPost(config, row.target.providerPostId);
        confirmation = { externalId: verified.externalId, url: verified.url };
      } else if (row.target.target === "youtube_shorts" && row.target.externalId) {
        const verified = await verifyYouTubeVideo(config, row.target.externalId, row.draft.locale === "en" ? "en" : "ru");
        confirmation = { externalId: verified.id, url: verified.url };
      }
    } catch {
      deferVideoReconciliation(backendDb, config, job, reconciliationWorker);
      continue;
    }
    if (!confirmation) {
      deferVideoReconciliation(backendDb, config, job, reconciliationWorker);
      continue;
    }
    const now = new Date().toISOString();
    unsafeDb(backendDb).db.transaction((tx) => {
      tx.update(videoTargets)
        .set({
          status: "published",
          externalId: confirmation?.externalId ?? row.target.externalId,
          externalUrl: confirmation?.url ?? row.target.externalUrl,
          lastError: null,
          publishedAt: row.target.publishedAt ?? now,
          confirmationSource: "provider_verify",
          verifiedAt: now,
          updatedAt: now,
        })
        .where(and(eq(videoTargets.id, row.target.id), eq(videoTargets.status, "verification_required")))
        .run();
      tx.update(videoJobs)
        .set({ status: "completed", lastError: null, lockedAt: null, lockedBy: null, updatedAt: now })
        .where(
          and(
            eq(videoJobs.videoTargetId, row.target.id),
            eq(videoJobs.status, "verification_required"),
            eq(videoJobs.lockedBy, reconciliationWorker),
          ),
        )
        .run();
    });
    refreshVideoDraftStatus(backendDb, row.target.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
    recordDomainEvent(backendDb.events, {
      ref: publicationRef("video", row.target.videoDraftId),
      target: row.target.target,
      type: "video.target.reconciled",
      severity: "info",
      message: `${row.target.target} video publication was confirmed`,
      details: { videoTargetId: row.target.id, confirmation_source: "provider_verify" },
    });
    resolved += 1;
  }

  // Age is read from the *targets*, never from the jobs. Deferring a poll
  // touches the job row, so measuring there would reset the incident's age on
  // every tick and an inbox that never ages is an inbox nobody escalates.
  const unresolvedTimes = [
    ...unsafeDb(backendDb)
      .db.select({ updatedAt: postTargets.updatedAt })
      .from(postTargets)
      .where(eq(postTargets.status, "verification_required"))
      .all(),
    ...unsafeDb(backendDb)
      .db.select({ updatedAt: videoTargets.updatedAt })
      .from(videoTargets)
      .where(eq(videoTargets.status, "verification_required"))
      .all(),
  ]
    .map((row) => row.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  if (unresolvedTimes.length) {
    recordDomainEvent(backendDb.events, {
      type: "studio.notification.publication_verification_required",
      severity: "warn",
      message: `${unresolvedTimes.length} publication(s) still require verification; oldest since ${unresolvedTimes[0]}`,
      details: { count: unresolvedTimes.length, oldest_at: unresolvedTimes[0] },
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
  }
  return { checked, resolved, unresolved: unresolvedTimes.length, oldestAt: unresolvedTimes[0] ?? null };
}

function deferOrdinaryReconciliation(
  backendDb: BackendDb,
  config: BackendConfig,
  job: typeof publishJobs.$inferSelect,
  owner: string,
): void {
  const attempt = job.reconcileAttemptCount + 1;
  unsafeDb(backendDb)
    .db.update(publishJobs)
    .set({
      reconcileAttemptCount: attempt,
      nextAttemptAt: reconciliationNextAttempt(config, attempt),
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "verification_required"), eq(publishJobs.lockedBy, owner)))
    .run();
}

function deferVideoReconciliation(backendDb: BackendDb, config: BackendConfig, job: typeof videoJobs.$inferSelect, owner: string): void {
  const attempt = job.reconcileAttemptCount + 1;
  unsafeDb(backendDb)
    .db.update(videoJobs)
    .set({
      reconcileAttemptCount: attempt,
      nextAttemptAt: reconciliationNextAttempt(config, attempt),
      lockedBy: null,
      lockedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(videoJobs.id, job.id), eq(videoJobs.status, "verification_required"), eq(videoJobs.lockedBy, owner)))
    .run();
}

function reconciliationNextAttempt(config: BackendConfig, attempt: number): string | null {
  if (attempt >= config.RECONCILE_MAX_ATTEMPTS) return null;
  return nextRetryAt(attempt, config.PUBLISH_BACKOFF_BASE_SECONDS, config.PUBLISH_BACKOFF_MAX_SECONDS);
}
