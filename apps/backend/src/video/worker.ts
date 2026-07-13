import crypto from "node:crypto";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { botSettings, videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import { nextRetryAt } from "../queue/errors.js";
import { formatVideoTime, getVideoDraft, refreshVideoDraftStatus, type VideoJob } from "./data.js";
import {
  InstagramContainerInvalidError,
  InstagramContainerProcessingError,
  instagramContainerReady,
  prepareInstagramReel,
  prepareYouTubeVideo,
  publishInstagramReel,
} from "./publishers.js";
import { videoPreview } from "./service.js";
import { deleteVideo, videoPath } from "./storage.js";
import type { InstagramMetadata, VideoMetadata, VideoTarget, YouTubeMetadata } from "./types.js";
import { videoTargetLabel } from "./types.js";

export async function runVideoCycle(config: BackendConfig, backendDb: BackendDb, bot: Bot | null): Promise<number> {
  if (!config.studio.modules.video_posting) return 0;
  recoverVideoLocks(backendDb, config.PUBLISH_LOCK_TIMEOUT_SECONDS);
  const jobs = claimVideoJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  for (const job of jobs) {
    try {
      await executeVideoJob(config, backendDb, bot, job);
      completeVideoJob(backendDb, job.id);
      await refreshVideoControlCard(backendDb, bot, job.videoDraftId);
    } catch (error) {
      failVideoJob(backendDb, job, error, config);
      await notifyFinalVideoFailure(backendDb, bot, job);
      await refreshVideoControlCard(backendDb, bot, job.videoDraftId);
    }
  }
  pruneExpiredVideos(config, backendDb);
  return jobs.length;
}

async function notifyFinalVideoFailure(backendDb: BackendDb, bot: Bot | null, job: VideoJob): Promise<void> {
  if (!bot || !job.videoTargetId) return;
  const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, job.videoTargetId)).get();
  if (target?.status !== "failed") return;
  const draft = getVideoDraft(backendDb, job.videoDraftId);
  const targetName = target.target as VideoTarget;
  await bot.api.sendMessage(
    draft.adminId,
    `🔴 ${videoTargetLabel(targetName)} не опубликовал ролик «${draft.label || "Без названия"}».\n\n${target.lastError || "Неизвестная ошибка"}`,
    {
      reply_markup: new InlineKeyboard().text(
        `🔁 Повторить ${targetName === "youtube_shorts" ? "YouTube" : "Instagram"}`,
        `video_retry:${targetName}:${draft.id}`,
      ),
    },
  );
}

async function refreshVideoControlCard(backendDb: BackendDb, bot: Bot | null, videoDraftId: number): Promise<void> {
  if (!bot) return;
  const draft = getVideoDraft(backendDb, videoDraftId);
  if (!draft.controlChatId || !draft.controlMessageId) return;
  const preview = videoPreview(backendDb, videoDraftId);
  try {
    await bot.api.editMessageText(draft.controlChatId, draft.controlMessageId, preview.text, {
      parse_mode: "Markdown",
      reply_markup: preview.keyboard,
    });
  } catch {
    // A deleted or manually edited Telegram message must not stop publication.
  }
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

async function executeVideoJob(config: BackendConfig, backendDb: BackendDb, bot: Bot | null, job: VideoJob): Promise<void> {
  if (job.kind === "reminder") return sendVideoReminder(backendDb, bot, job.videoDraftId, job.videoTargetId, config.VIDEO_REMINDER_MINUTES);
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

async function sendVideoReminder(
  backendDb: BackendDb,
  bot: Bot | null,
  videoDraftId: number,
  videoTargetId: number | null,
  reminderMinutes: number,
): Promise<void> {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const target = videoTargetId == null ? null : backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (!bot || !target || draft.status !== "scheduled") return;
  const text = `⏰ Через ${reminderMinutes} мин. публикация:\n\n🎬 ${draft.label || "Без названия"}\n• ${videoTargetLabel(target.target as VideoTarget)}\n\n${formatVideoTime(target.scheduledAt)}`;
  await bot.api.sendMessage(draft.adminId, text, {
    reply_markup: new InlineKeyboard().text("Открыть", `video_open:${draft.id}`).text("Отменить", `video_cancel:${draft.id}`),
  });
  backendDb.db
    .update(videoDrafts)
    .set({
      reminderSentAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(videoDrafts.id, draft.id))
    .run();
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
