import crypto from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { deleteVideo, videoPublicUrl, videoSourcePath } from "../content/video-assets.js";
import type { BackendDb } from "../db/client.js";
import { botSettings, videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { nextRetryAt } from "../publishing/errors.js";
import { failedJobTransition } from "../publishing/job-policy.js";
import { getVideoDraft, refreshVideoDraftStatus, type VideoJob } from "../publishing/video-data.js";
import type { InstagramMetadata, VideoMetadata, YouTubeMetadata } from "../publishing/video-types.js";
import {
  InstagramContainerInvalidError,
  InstagramContainerProcessingError,
  instagramContainerReady,
  keepYouTubeUploadPrivate,
  prepareInstagramReel,
  prepareYouTubeVideo,
  publishInstagramReel,
} from "./video-publishers.js";
import { publishZernioInstagramReel } from "./zernio.js";

export async function runVideoCycle(config: BackendConfig, backendDb: BackendDb): Promise<number> {
  if (!config.studio.modules.video_posting) return 0;
  recoverVideoLocks(backendDb, config);
  const jobs = claimVideoJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  for (const job of jobs) {
    try {
      await withHeartbeat(backendDb, job.id, config.VIDEO_HEARTBEAT_INTERVAL_SECONDS, () => executeVideoJob(config, backendDb, job));
      if (completeVideoJob(backendDb, job)) {
        recordVideoProgressEvent(backendDb, job, "video.job.completed");
        recordVideoCompletionIfFinal(backendDb, job.videoDraftId);
      }
    } catch (error) {
      if (failVideoJob(backendDb, job, error, config)) {
        recordVideoProgressEvent(backendDb, job, "video.job.failed");
        recordVideoCompletionIfFinal(backendDb, job.videoDraftId);
      }
    }
  }
  pruneExpiredVideos(config, backendDb);
  return jobs.length;
}

/** Keeps a claimed job's lock fresh while a long-running upload/poll is in
 * flight, so recoverVideoLocks can use a short timeout without mistaking
 * "still working" for "worker crashed". Silence (a real crash) still goes
 * stale after VIDEO_LOCK_TIMEOUT_SECONDS with no heartbeat. */
async function withHeartbeat<T>(backendDb: BackendDb, jobId: number, intervalSeconds: number, work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    backendDb.db
      .update(videoJobs)
      .set({ lockedAt: new Date().toISOString() })
      .where(and(eq(videoJobs.id, jobId), eq(videoJobs.status, "running")))
      .run();
  }, intervalSeconds * 1000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Keeps target state updates consistent across the prepare/publish/fail/recovery paths. */
function updateVideoTarget(db: BackendDb["db"], targetId: number, patch: Partial<typeof videoTargets.$inferInsert>): void {
  db.update(videoTargets)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(videoTargets.id, targetId))
    .run();
}

function recordVideoCompletionIfFinal(backendDb: BackendDb, videoDraftId: number): void {
  const targets = backendDb.db
    .select({ status: videoTargets.status })
    .from(videoTargets)
    .where(eq(videoTargets.videoDraftId, videoDraftId))
    .all();
  if (!targets.length || !targets.every((target) => ["published", "failed", "cancelled"].includes(target.status))) return;
  const failed = targets.filter((target) => target.status === "failed").length;
  recordDomainEvent(backendDb, {
    ref: `video:${videoDraftId}`,
    type: "delivery.video.completed",
    severity: failed ? "warn" : "info",
    message: failed ? `Video #${videoDraftId} completed with ${failed} failed target(s)` : `Video #${videoDraftId} published successfully`,
    details: { videoDraftId, total: targets.length, failed, published: targets.filter((target) => target.status === "published").length },
    cooldownSeconds: 60 * 60,
  });
}

function claimVideoJobs(backendDb: BackendDb, limit: number): VideoJob[] {
  const now = new Date().toISOString();
  const rows = backendDb.db
    .select()
    .from(videoJobs)
    .where(
      and(
        eq(videoJobs.status, "queued"),
        lte(videoJobs.runAt, now),
        or(isNull(videoJobs.nextAttemptAt), lte(videoJobs.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(videoJobs.runAt), asc(videoJobs.id))
    .limit(limit)
    .all();
  const claimed: VideoJob[] = [];
  backendDb.db.transaction((tx) => {
    for (const job of rows) {
      const updated = tx
        .update(videoJobs)
        .set({
          status: "running",
          lockedBy: `${process.pid}:${crypto.randomUUID()}`,
          lockedAt: now,
          updatedAt: now,
        })
        .where(and(eq(videoJobs.id, job.id), eq(videoJobs.status, "queued")))
        .returning()
        .get();
      if (updated) claimed.push(updated);
    }
  });
  return claimed;
}

async function executeVideoJob(config: BackendConfig, backendDb: BackendDb, job: VideoJob): Promise<void> {
  if (job.kind === "reminder") {
    recordDomainEvent(backendDb, {
      ref: `video:${job.videoDraftId}`,
      type: "video.reminder.due",
      severity: "info",
      message: `Video reminder due for draft #${job.videoDraftId}`,
      details: { videoDraftId: job.videoDraftId, videoTargetId: job.videoTargetId },
    });
    return;
  }
  if (!job.videoTargetId) throw new Error("Video platform job has no target.");
  const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, job.videoTargetId)).get();
  const draft = getVideoDraft(backendDb, job.videoDraftId);
  if (!target || target.status === "cancelled" || target.status === "published") return;
  const filePath = videoSourcePath(backendDb, config, draft);
  if (!filePath) throw new Error("Video source was removed before publication completed.");
  const metadata = target.metadataJson as VideoMetadata;
  if (job.kind === "prepare") {
    if (target.target === "youtube_shorts") {
      const result = await prepareYouTubeVideo(
        config,
        filePath,
        {
          ...(metadata as YouTubeMetadata),
          description: composeYouTubeDescription(backendDb, draft.adminId, metadata as YouTubeMetadata),
        },
        target.scheduledAt ?? new Date().toISOString(),
      );
      if (!ownsVideoJob(backendDb, job)) {
        // Cancellation can happen while the resumable upload is in flight. The
        // ID exists only in this response, so fence its future public release
        // before discarding it from local state.
        try {
          await keepYouTubeUploadPrivate(config, result.id);
        } catch (error) {
          recordDomainEvent(backendDb, {
            ref: `video:${job.videoDraftId}`,
            type: "studio.notification.video_cancelled",
            severity: "warn",
            target: "youtube_shorts",
            message: "A cancelled YouTube upload could not be kept private; check it manually.",
            details: { videoDraftId: job.videoDraftId, videoId: result.id, error: error instanceof Error ? error.message : String(error) },
          });
        }
        return;
      }
      updateVideoTarget(backendDb.db, target.id, {
        status: "prepared",
        externalId: result.id,
        externalUrl: result.url,
        preparedAt: new Date().toISOString(),
      });
    } else if (target.deliveryProvider === "zernio") {
      // Zernio accepts the public video at its publish time, so prepare is a
      // local checkpoint only. Publishing early would violate the schedule.
      if (!target.providerAccountId) throw new Error("Zernio Instagram account is missing");
      updateVideoTarget(backendDb.db, target.id, { status: "prepared", preparedAt: new Date().toISOString() });
    } else {
      const result = await prepareInstagramReel(config, videoPublicUrl(backendDb, config, draft), metadata as InstagramMetadata);
      if (!ownsVideoJob(backendDb, job)) return;
      updateVideoTarget(backendDb.db, target.id, { status: "prepared", externalId: result.id, preparedAt: new Date().toISOString() });
    }
    return;
  }
  if (target.target === "youtube_shorts") {
    if (!target.externalId) throw new Error("YouTube upload has not completed yet.");
    if (!ownsVideoJob(backendDb, job)) return;
    updateVideoTarget(backendDb.db, target.id, { status: "published", publishedAt: new Date().toISOString() });
  } else if (target.deliveryProvider === "zernio") {
    const accountId = target.providerAccountId;
    if (!accountId) throw new Error("Zernio Instagram account is missing");
    const result = await publishZernioInstagramReel(config, {
      accountId,
      publicUrl: videoPublicUrl(backendDb, config, draft),
      metadata: metadata as InstagramMetadata,
      requestId: `video-target:${target.id}`,
    });
    if (!ownsVideoJob(backendDb, job)) return;
    updateVideoTarget(backendDb.db, target.id, {
      status: "published",
      providerPostId: result.providerPostId,
      externalId: result.externalId,
      externalUrl: result.url,
      publishedAt: new Date().toISOString(),
    });
  } else {
    if (!target.externalId) throw new Error("Instagram upload has not completed yet.");
    await instagramContainerReady(config, target.externalId);
    if (!ownsVideoJob(backendDb, job)) return;
    const result = await publishInstagramReel(config, target.externalId);
    if (!ownsVideoJob(backendDb, job)) return;
    updateVideoTarget(backendDb.db, target.id, {
      status: "published",
      externalId: result.id,
      externalUrl: result.url,
      publishedAt: new Date().toISOString(),
    });
  }
  refreshVideoDraftStatus(backendDb, draft.id, config.VIDEO_MEDIA_RETENTION_HOURS);
}

function recordVideoProgressEvent(backendDb: BackendDb, job: VideoJob, type: string): void {
  recordDomainEvent(backendDb, {
    ref: `video:${job.videoDraftId}`,
    type,
    severity: "info",
    message: `Video job ${job.kind} settled for draft #${job.videoDraftId}`,
    details: { videoDraftId: job.videoDraftId, videoTargetId: job.videoTargetId, jobId: job.id, kind: job.kind },
  });
}

function completeVideoJob(backendDb: BackendDb, job: VideoJob): boolean {
  const completed = backendDb.db
    .update(videoJobs)
    .set({
      status: "completed",
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date().toISOString(),
    })
    .where(activeVideoJob(job))
    .returning({ id: videoJobs.id })
    .get();
  return completed != null;
}

function failVideoJob(backendDb: BackendDb, job: VideoJob, cause: unknown, config: BackendConfig): boolean {
  const error = cause instanceof Error ? cause.message : String(cause);
  const attempts = job.attemptCount + 1;
  if (cause instanceof InstagramContainerProcessingError && attempts < config.PUBLISH_MAX_ATTEMPTS) {
    const now = new Date().toISOString();
    let failed = false;
    backendDb.db.transaction((tx) => {
      const updated = tx
        .update(videoJobs)
        .set({
          status: "queued",
          attemptCount: attempts,
          nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
          lockedAt: null,
          lockedBy: null,
          lastError: error,
          updatedAt: now,
        })
        .where(activeVideoJob(job))
        .returning({ id: videoJobs.id })
        .get();
      if (!updated) return;
      failed = true;
      if (job.videoTargetId) updateVideoTarget(tx, job.videoTargetId, { status: "prepared", lastError: null });
    });
    return failed;
  }
  const retry = attempts < config.PUBLISH_MAX_ATTEMPTS;
  const now = new Date().toISOString();
  let failed = false;
  backendDb.db.transaction((tx) => {
    const updated = tx
      .update(videoJobs)
      .set({
        status: retry ? "queued" : "failed",
        attemptCount: attempts,
        nextAttemptAt: retry ? nextRetryAt(attempts, config.PUBLISH_BACKOFF_BASE_SECONDS, config.PUBLISH_BACKOFF_MAX_SECONDS) : null,
        lockedAt: null,
        lockedBy: null,
        lastError: error,
        updatedAt: now,
      })
      .where(activeVideoJob(job))
      .returning({ id: videoJobs.id })
      .get();
    if (!updated) return;
    failed = true;
    if (job.videoTargetId && cause instanceof InstagramContainerInvalidError && job.kind === "publish" && retry) {
      requeueInstagramPreparation(tx, job, error, now, attempts);
    } else if (job.videoTargetId) updateVideoTarget(tx, job.videoTargetId, { status: retry ? "scheduled" : "failed", lastError: error });
  });
  if (!failed) return false;
  refreshVideoDraftStatus(backendDb, job.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
  if (!retry) {
    const target =
      job.videoTargetId == null
        ? null
        : backendDb.db.select({ target: videoTargets.target }).from(videoTargets).where(eq(videoTargets.id, job.videoTargetId)).get();
    recordDomainEvent(backendDb, {
      ref: `video:${job.videoDraftId}`,
      type: "video.target.failed",
      severity: "error",
      target: target?.target ?? "video",
      message: error,
      details: { videoDraftId: job.videoDraftId, videoTargetId: job.videoTargetId, jobId: job.id, kind: job.kind },
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
  }
  return true;
}

/** Instagram containers can go stale between prepare and publish; re-run prepare
 * from scratch instead of retrying the publish call against a dead container. */
function requeueInstagramPreparation(tx: BackendDb["db"], job: VideoJob, error: string, now: string, attempts: number): void {
  if (!job.videoTargetId) return;
  updateVideoTarget(tx, job.videoTargetId, {
    status: "scheduled",
    externalId: null,
    externalUrl: null,
    preparedAt: null,
    lastError: error,
  });
  tx.update(videoJobs)
    .set({
      status: "queued",
      runAt: now,
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: now,
    })
    .where(and(eq(videoJobs.videoDraftId, job.videoDraftId), eq(videoJobs.videoTargetId, job.videoTargetId), eq(videoJobs.kind, "prepare")))
    .run();
  tx.update(videoJobs)
    .set({
      status: "queued",
      attemptCount: attempts,
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      lockedAt: null,
      lockedBy: null,
      lastError: error,
      updatedAt: now,
    })
    .where(eq(videoJobs.id, job.id))
    .run();
}

function composeYouTubeDescription(backendDb: BackendDb, adminId: number, metadata: YouTubeMetadata): string {
  const signature = backendDb.db
    .select({ value: botSettings.youtubeSignature })
    .from(botSettings)
    .where(eq(botSettings.adminId, adminId))
    .get()
    ?.value.trim();
  const gameLine = metadata.gameUrl ? `📀 Steam: ${metadata.gameUrl}` : "";
  return [metadata.description.trim(), gameLine, signature].filter(Boolean).join("\n\n");
}

/** Mirrors the social pipeline's recoverStalePublishJobs (publishing/queue.ts): a
 * crashed/killed worker's job re-enters the normal retry/backoff budget instead
 * of dead-ending in "failed" until an operator notices and retries by hand. The
 * "unknown" error class this produces gets exactly one safety-net retry, same
 * as the social pipeline, so a genuinely stuck target still terminates quickly. */
export function recoverVideoLocks(backendDb: BackendDb, config: BackendConfig): number {
  const cutoff = new Date(Date.now() - config.VIDEO_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();
  const stale = backendDb.db
    .select()
    .from(videoJobs)
    .where(and(eq(videoJobs.status, "running"), lte(videoJobs.lockedAt, cutoff)))
    .all();
  let recovered = 0;
  const terminalFailures: Array<{ job: VideoJob; error: string }> = [];
  backendDb.db.transaction((tx) => {
    for (const job of stale) {
      if (!job.lockedAt) continue;
      const error = "worker_lost: video lock expired before completion";
      const transition = failedJobTransition(new Error(error), job.attemptCount, {
        maxAttempts: config.PUBLISH_MAX_ATTEMPTS,
        backoffBaseSeconds: config.PUBLISH_BACKOFF_BASE_SECONDS,
        backoffMaxSeconds: config.PUBLISH_BACKOFF_MAX_SECONDS,
      });
      const retry = transition.status === "queued";
      const updated = tx
        .update(videoJobs)
        .set({
          status: transition.status,
          attemptCount: transition.attempt,
          nextAttemptAt: transition.nextAttemptAt,
          lockedAt: null,
          lockedBy: null,
          lastError: error,
          updatedAt: now,
        })
        .where(and(eq(videoJobs.id, job.id), eq(videoJobs.status, "running"), eq(videoJobs.lockedAt, job.lockedAt)))
        .returning({ id: videoJobs.id })
        .get();
      if (!updated) continue;
      recovered += 1;
      if (job.videoTargetId) updateVideoTarget(tx, job.videoTargetId, { status: retry ? "scheduled" : "failed", lastError: error });
      if (!retry) terminalFailures.push({ job, error });
    }
  });
  for (const job of stale) refreshVideoDraftStatus(backendDb, job.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
  for (const { job, error } of terminalFailures) {
    const target =
      job.videoTargetId == null
        ? null
        : backendDb.db.select({ target: videoTargets.target }).from(videoTargets).where(eq(videoTargets.id, job.videoTargetId)).get();
    recordDomainEvent(backendDb, {
      ref: `video:${job.videoDraftId}`,
      type: "video.target.failed",
      severity: "error",
      target: target?.target ?? "video",
      message: error,
      details: { videoDraftId: job.videoDraftId, videoTargetId: job.videoTargetId, jobId: job.id, kind: job.kind },
      cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    });
    recordVideoCompletionIfFinal(backendDb, job.videoDraftId);
  }
  return recovered;
}

function ownsVideoJob(backendDb: BackendDb, job: VideoJob): boolean {
  return backendDb.db.select({ id: videoJobs.id }).from(videoJobs).where(activeVideoJob(job)).get() != null;
}

function activeVideoJob(job: VideoJob) {
  return and(
    eq(videoJobs.id, job.id),
    eq(videoJobs.status, "running"),
    job.lockedBy == null ? sql`false` : eq(videoJobs.lockedBy, job.lockedBy),
  );
}

function pruneExpiredVideos(config: BackendConfig, backendDb: BackendDb): void {
  const now = new Date().toISOString();
  const legacyDraftExpiresAt = new Date(Date.now() - config.VIDEO_MEDIA_RETENTION_HOURS * 60 * 60_000).toISOString();
  const rows = backendDb.db
    .select()
    .from(videoDrafts)
    .where(
      or(
        and(
          lte(videoDrafts.retentionUntil, now),
          or(
            eq(videoDrafts.status, "published"),
            eq(videoDrafts.status, "partial"),
            eq(videoDrafts.status, "cancelled"),
            eq(videoDrafts.status, "editing"),
          ),
        ),
        and(eq(videoDrafts.status, "editing"), isNull(videoDrafts.retentionUntil), lte(videoDrafts.createdAt, legacyDraftExpiresAt)),
      ),
    )
    .all();
  for (const row of rows) {
    if (row.studioMediaAssetId == null) deleteVideo(config, row.assetKey);
    backendDb.db
      .update(videoDrafts)
      .set({
        status: row.status === "editing" ? "cancelled" : row.status,
        retentionUntil: null,
        updatedAt: now,
      })
      .where(eq(videoDrafts.id, row.id))
      .run();
  }
}
