import crypto from "node:crypto";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
import { deleteVideo, videoPath } from "../content/video-assets.js";
import type { BackendDb } from "../db/client.js";
import { botSettings, videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import { nextRetryAt } from "../publishing/errors.js";
import { getVideoDraft, refreshVideoDraftStatus, type VideoJob } from "../publishing/video-data.js";
import type { InstagramMetadata, VideoMetadata, YouTubeMetadata } from "../publishing/video-types.js";
import {
  InstagramContainerInvalidError,
  InstagramContainerProcessingError,
  instagramContainerReady,
  prepareInstagramReel,
  prepareYouTubeVideo,
  publishInstagramReel,
} from "./video-publishers.js";

type VideoCycleHooks = {
  sendReminder?: (job: VideoJob) => Promise<void>;
  notifyFinalFailure?: (job: VideoJob) => Promise<void>;
  refreshProgress?: (videoDraftId: number) => Promise<void>;
};

export async function runVideoCycle(config: BackendConfig, backendDb: BackendDb, hooks: VideoCycleHooks = {}): Promise<number> {
  if (!config.studio.modules.video_posting) return 0;
  recoverVideoLocks(backendDb, config.PUBLISH_LOCK_TIMEOUT_SECONDS);
  const jobs = claimVideoJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  for (const job of jobs) {
    try {
      await executeVideoJob(config, backendDb, hooks, job);
      completeVideoJob(backendDb, job.id);
      await hooks.refreshProgress?.(job.videoDraftId);
    } catch (error) {
      failVideoJob(backendDb, job, error, config);
      await hooks.notifyFinalFailure?.(job);
      await hooks.refreshProgress?.(job.videoDraftId);
    }
  }
  pruneExpiredVideos(config, backendDb);
  return jobs.length;
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

async function executeVideoJob(config: BackendConfig, backendDb: BackendDb, hooks: VideoCycleHooks, job: VideoJob): Promise<void> {
  if (job.kind === "reminder") return hooks.sendReminder?.(job);
  if (!job.videoTargetId) throw new Error("Video platform job has no target.");
  const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, job.videoTargetId)).get();
  const draft = getVideoDraft(backendDb, job.videoDraftId);
  if (!target || target.status === "cancelled" || target.status === "published") return;
  const filePath = videoPath(config, draft.assetKey);
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
      backendDb.db
        .update(videoTargets)
        .set({
          status: "prepared",
          externalId: result.id,
          externalUrl: result.url,
          preparedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(videoTargets.id, target.id))
        .run();
    } else {
      const result = await prepareInstagramReel(
        config,
        `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/media/video/${draft.assetKey}`,
        metadata as InstagramMetadata,
      );
      backendDb.db
        .update(videoTargets)
        .set({
          status: "prepared",
          externalId: result.id,
          preparedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(videoTargets.id, target.id))
        .run();
    }
    return;
  }
  if (target.target === "youtube_shorts") {
    if (!target.externalId) throw new Error("YouTube upload has not completed yet.");
    backendDb.db
      .update(videoTargets)
      .set({
        status: "published",
        publishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(videoTargets.id, target.id))
      .run();
  } else {
    if (!target.externalId) throw new Error("Instagram upload has not completed yet.");
    await instagramContainerReady(config, target.externalId);
    const result = await publishInstagramReel(config, target.externalId);
    backendDb.db
      .update(videoTargets)
      .set({
        status: "published",
        externalId: result.id,
        externalUrl: result.url,
        publishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(videoTargets.id, target.id))
      .run();
  }
  refreshVideoDraftStatus(backendDb, draft.id, config.VIDEO_MEDIA_RETENTION_HOURS);
}

function completeVideoJob(backendDb: BackendDb, id: number): void {
  backendDb.db
    .update(videoJobs)
    .set({
      status: "completed",
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(videoJobs.id, id))
    .run();
}

function failVideoJob(backendDb: BackendDb, job: VideoJob, cause: unknown, config: BackendConfig): void {
  const error = cause instanceof Error ? cause.message : String(cause);
  const attempts = job.attemptCount + 1;
  if (cause instanceof InstagramContainerProcessingError && attempts < config.PUBLISH_MAX_ATTEMPTS) {
    const now = new Date().toISOString();
    backendDb.db.transaction((tx) => {
      tx.update(videoJobs)
        .set({
          status: "queued",
          attemptCount: attempts,
          nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
          lockedAt: null,
          lockedBy: null,
          lastError: error,
          updatedAt: now,
        })
        .where(eq(videoJobs.id, job.id))
        .run();
      if (job.videoTargetId)
        tx.update(videoTargets)
          .set({ status: "prepared", lastError: null, updatedAt: now })
          .where(eq(videoTargets.id, job.videoTargetId))
          .run();
    });
    return;
  }
  const retry = attempts < config.PUBLISH_MAX_ATTEMPTS;
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    tx.update(videoJobs)
      .set({
        status: retry ? "queued" : "failed",
        attemptCount: attempts,
        nextAttemptAt: retry ? nextRetryAt(attempts, config.PUBLISH_BACKOFF_BASE_SECONDS, config.PUBLISH_BACKOFF_MAX_SECONDS) : null,
        lockedAt: null,
        lockedBy: null,
        lastError: error,
        updatedAt: now,
      })
      .where(eq(videoJobs.id, job.id))
      .run();
    if (job.videoTargetId && cause instanceof InstagramContainerInvalidError && job.kind === "publish" && retry) {
      tx.update(videoTargets)
        .set({
          status: "scheduled",
          externalId: null,
          externalUrl: null,
          preparedAt: null,
          lastError: error,
          updatedAt: now,
        })
        .where(eq(videoTargets.id, job.videoTargetId))
        .run();
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
        .where(
          and(eq(videoJobs.videoDraftId, job.videoDraftId), eq(videoJobs.videoTargetId, job.videoTargetId), eq(videoJobs.kind, "prepare")),
        )
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
    } else if (job.videoTargetId)
      tx.update(videoTargets)
        .set({
          status: retry ? "scheduled" : "failed",
          lastError: error,
          updatedAt: now,
        })
        .where(eq(videoTargets.id, job.videoTargetId))
        .run();
  });
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

function recoverVideoLocks(backendDb: BackendDb, timeoutSeconds: number): void {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000).toISOString();
  backendDb.db
    .update(videoJobs)
    .set({
      status: "queued",
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(videoJobs.status, "running"), lte(videoJobs.lockedAt, cutoff)))
    .run();
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
    deleteVideo(config, row.assetKey);
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
