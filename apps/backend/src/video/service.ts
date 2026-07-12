import crypto from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import { nextRetryAt } from "../queue/errors.js";
import { instagramContainerReady, prepareInstagramReel, prepareYouTubeVideo, publishInstagramReel } from "./publishers.js";
import { deleteVideo, videoPath } from "./storage.js";
import type { InstagramMetadata, VideoMetadata, VideoTarget, YouTubeMetadata } from "./types.js";
import { VIDEO_TARGETS, videoTargetLabel } from "./types.js";

type VideoDraft = typeof videoDrafts.$inferSelect;
type VideoTargetRow = typeof videoTargets.$inferSelect;
type VideoJob = typeof videoJobs.$inferSelect;
type JobKind = "prepare" | "publish" | "reminder";

export function createVideoDraft(backendDb: BackendDb, adminId: number, assetKey: string): number {
  const now = new Date().toISOString();
  const row = backendDb.db
    .insert(videoDrafts)
    .values({ adminId, assetKey, status: "editing", createdAt: now, updatedAt: now })
    .returning({ id: videoDrafts.id })
    .get();
  if (!row) throw new Error("Could not create video draft.");
  return row.id;
}

function getVideoDraft(backendDb: BackendDb, id: number): VideoDraft {
  const draft = backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, id)).get();
  if (!draft) throw new Error("Video publication was not found.");
  return draft;
}

export function listVideoTargets(backendDb: BackendDb, videoDraftId: number): VideoTargetRow[] {
  return backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).orderBy(asc(videoTargets.id)).all();
}

export function updateVideoLabel(backendDb: BackendDb, id: number, label: string): void {
  backendDb.db.update(videoDrafts).set({ label: label.trim(), updatedAt: new Date().toISOString() }).where(eq(videoDrafts.id, id)).run();
}

export function setVideoControlCard(backendDb: BackendDb, id: number, chatId: number, messageId: number): void {
  backendDb.db
    .update(videoDrafts)
    .set({ controlChatId: chatId, controlMessageId: messageId, updatedAt: new Date().toISOString() })
    .where(eq(videoDrafts.id, id))
    .run();
}

export function replaceVideoTargets(backendDb: BackendDb, videoDraftId: number, targets: VideoTarget[]): void {
  const allowed = targets.filter((target, index) => VIDEO_TARGETS.includes(target) && targets.indexOf(target) === index);
  if (allowed.length === 0) throw new Error("Choose at least one video platform.");
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    tx.delete(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).run();
    for (const target of allowed) {
      tx.insert(videoTargets).values({ videoDraftId, target, metadataJson: {}, status: "editing", createdAt: now, updatedAt: now }).run();
    }
    tx.update(videoDrafts).set({ status: "editing", updatedAt: now }).where(eq(videoDrafts.id, videoDraftId)).run();
  });
}

export function saveVideoMetadata(backendDb: BackendDb, videoDraftId: number, target: VideoTarget, metadata: VideoMetadata): void {
  backendDb.db
    .update(videoTargets)
    .set({ metadataJson: metadata as Record<string, unknown>, updatedAt: new Date().toISOString() })
    .where(and(eq(videoTargets.videoDraftId, videoDraftId), eq(videoTargets.target, target)))
    .run();
}

export function scheduleVideo(
  backendDb: BackendDb,
  videoDraftId: number,
  schedule: Partial<Record<VideoTarget, Date>>,
  timing: { prepareLeadMinutes: number; reminderMinutes: number },
): void {
  const now = new Date();
  const targets = listVideoTargets(backendDb, videoDraftId);
  if (targets.length === 0) throw new Error("Choose video platforms first.");
  for (const target of targets) {
    const date = schedule[target.target as VideoTarget];
    if (!date || Number.isNaN(date.getTime()) || date.getTime() <= now.getTime())
      throw new Error("Publication time must be in the future.");
  }
  const scheduledTargets = targets.map((target) => schedule[target.target as VideoTarget]).filter((date): date is Date => Boolean(date));
  const common = Math.min(...scheduledTargets.map((date) => date.getTime()));
  backendDb.db.transaction((tx) => {
    for (const target of targets) {
      const targetSchedule = schedule[target.target as VideoTarget];
      if (!targetSchedule) throw new Error("Publication time must be in the future.");
      const publishAt = targetSchedule.toISOString();
      const preparedAt = new Date(targetSchedule.getTime() - timing.prepareLeadMinutes * 60_000);
      const reminderAt = new Date(targetSchedule.getTime() - timing.reminderMinutes * 60_000);
      tx.update(videoTargets)
        .set({ scheduledAt: publishAt, status: "scheduled", lastError: null, updatedAt: now.toISOString() })
        .where(eq(videoTargets.id, target.id))
        .run();
      insertVideoJob(tx, videoDraftId, target.id, "prepare", preparedAt.toISOString());
      insertVideoJob(tx, videoDraftId, target.id, "publish", publishAt);
      insertVideoJob(tx, videoDraftId, target.id, "reminder", reminderAt.toISOString());
    }
    tx.update(videoDrafts)
      .set({
        status: "scheduled",
        scheduledAt: new Date(common).toISOString(),
        reminderSentAt: null,
        retentionUntil: null,
        updatedAt: now.toISOString(),
      })
      .where(eq(videoDrafts.id, videoDraftId))
      .run();
  });
}

export function validateVideoDraft(config: BackendConfig, backendDb: BackendDb, videoDraftId: number): void {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const source = videoPath(config, draft.assetKey);
  if (!source) throw new Error("Исходное видео не найдено на сервере. Отправьте файл ещё раз.");
  if (path.extname(source).toLowerCase() !== ".mp4") throw new Error("Для Shorts и Reels нужен файл MP4.");
  const size = statSync(source).size;
  if (size <= 0) throw new Error("Видео пустое. Отправьте файл ещё раз.");
  if (size > config.VIDEO_MAX_BYTES)
    throw new Error(
      `Видео слишком большое: ${Math.ceil(size / 1024 / 1024)} МБ. Лимит профиля: ${Math.floor(config.VIDEO_MAX_BYTES / 1024 / 1024)} МБ.`,
    );
  for (const target of listVideoTargets(backendDb, videoDraftId)) {
    if (target.target === "youtube_shorts" && (!config.YOUTUBE_CLIENT_ID || !config.YOUTUBE_CLIENT_SECRET || !config.YOUTUBE_REFRESH_TOKEN))
      throw new Error("YouTube не настроен: нужны OAuth-ключи и refresh token.");
    if (target.target === "instagram_reels" && (!config.INSTAGRAM_ACCESS_TOKEN || !config.INSTAGRAM_USER_ID))
      throw new Error("Instagram не настроен: нужны access token и user ID.");
  }
}

function insertVideoJob(tx: BackendDb["db"], videoDraftId: number, videoTargetId: number | null, kind: JobKind, runAt: string): void {
  const exists = tx
    .select({ id: videoJobs.id })
    .from(videoJobs)
    .where(
      and(
        eq(videoJobs.videoDraftId, videoDraftId),
        videoTargetId == null ? isNull(videoJobs.videoTargetId) : eq(videoJobs.videoTargetId, videoTargetId),
        eq(videoJobs.kind, kind),
      ),
    )
    .get();
  const now = new Date().toISOString();
  if (exists) {
    tx.update(videoJobs)
      .set({
        runAt,
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(videoJobs.id, exists.id))
      .run();
  } else tx.insert(videoJobs).values({ videoDraftId, videoTargetId, kind, runAt, createdAt: now, updatedAt: now }).run();
}

export function videoPreview(backendDb: BackendDb, videoDraftId: number): { text: string; keyboard: InlineKeyboard } {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const targets = listVideoTargets(backendDb, videoDraftId);
  const lines = [`🎬 *${escapeMarkdown(draft.label || "Untitled")}*`, `Status: *${draft.status.toUpperCase()}*`];
  for (const target of targets) {
    lines.push(
      `• ${videoTargetLabel(target.target as VideoTarget)}: ${target.status}${target.scheduledAt ? ` · ${formatTime(target.scheduledAt)}` : ""}`,
    );
  }
  const keyboard = new InlineKeyboard();
  const ytTarget = targets.find((t) => t.target === "youtube_shorts");
  const igTarget = targets.find((t) => t.target === "instagram_reels");

  if (ytTarget) {
    keyboard.text("🕒 Time YT", `video_time:youtube_shorts:${draft.id}`);
    keyboard.text("❌ Remove YT", `video_remove:youtube_shorts:${draft.id}`).row();
  }
  if (igTarget) {
    keyboard.text("🕒 Time IG", `video_time:instagram_reels:${draft.id}`);
    keyboard.text("❌ Remove IG", `video_remove:instagram_reels:${draft.id}`).row();
  }
  if (targets.length > 0 && (draft.status === "draft" || draft.status === "editing")) {
    keyboard.text("📅 Schedule", `video_schedule:${draft.id}`).row();
  }

  keyboard.text("✏️ Edit text", `video_edit_menu:${draft.id}`);
  keyboard.text("🗑 Delete video", `video_cancel:${draft.id}`).row();
  keyboard.text("← Back to Queue", "queue_home");

  return { text: lines.join("\n"), keyboard };
}

export function cancelVideo(backendDb: BackendDb, videoDraftId: number, retentionHours: number): void {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    tx.update(videoJobs)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(videoJobs.videoDraftId, videoDraftId), eq(videoJobs.status, "queued")))
      .run();
    tx.update(videoTargets)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(videoTargets.videoDraftId, videoDraftId), eq(videoTargets.status, "queued")))
      .run();
    tx.update(videoDrafts)
      .set({ status: "cancelled", retentionUntil: new Date(Date.now() + retentionHours * 60 * 60_000).toISOString(), updatedAt: now })
      .where(eq(videoDrafts.id, videoDraftId))
      .run();
  });
}

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
      failVideoJob(backendDb, job, String(error instanceof Error ? error.message : error), config);
      await refreshVideoControlCard(backendDb, bot, job.videoDraftId);
    }
  }
  pruneExpiredVideos(config, backendDb);
  return jobs.length;
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
        .set({ status: "running", lockedBy: `${process.pid}:${crypto.randomUUID()}`, lockedAt: now, updatedAt: now })
        .where(and(eq(videoJobs.id, job.id), eq(videoJobs.status, "queued")))
        .returning()
        .get();
      if (updated) claimed.push(updated);
    }
  });
  return claimed;
}

async function executeVideoJob(config: BackendConfig, backendDb: BackendDb, bot: Bot | null, job: VideoJob): Promise<void> {
  if (job.kind === "reminder") return sendVideoReminder(backendDb, bot, job.videoDraftId, job.videoTargetId);
  if (!job.videoTargetId) throw new Error("Video platform job has no target.");
  const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, job.videoTargetId)).get();
  const draft = getVideoDraft(backendDb, job.videoDraftId);
  if (!target || ["cancelled", "published"].includes(target.status)) return;
  const filePath = videoPath(config, draft.assetKey);
  if (!filePath) throw new Error("Video source was removed before publication completed.");
  const metadata = target.metadataJson as VideoMetadata;
  if (job.kind === "prepare") {
    if (target.target === "youtube_shorts") {
      const result = await prepareYouTubeVideo(
        config,
        filePath,
        metadata as YouTubeMetadata,
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
        .set({ status: "prepared", externalId: result.id, preparedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(videoTargets.id, target.id))
        .run();
    }
    return;
  }
  if (target.target === "youtube_shorts") {
    if (!target.externalId) throw new Error("YouTube upload has not completed yet.");
    backendDb.db
      .update(videoTargets)
      .set({ status: "published", publishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(videoTargets.id, target.id))
      .run();
  } else {
    if (!target.externalId) throw new Error("Instagram upload has not completed yet.");
    if (!(await instagramContainerReady(config, target.externalId))) throw new Error("Instagram is still processing the Reel.");
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

async function sendVideoReminder(backendDb: BackendDb, bot: Bot | null, videoDraftId: number, videoTargetId: number | null): Promise<void> {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const target = videoTargetId == null ? null : backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, videoTargetId)).get();
  if (!bot || !target || draft.status !== "scheduled") return;
  const text = `⏰ Через 5 минут публикация:\n\n🎬 ${draft.label || "Без названия"}\n• ${videoTargetLabel(target.target as VideoTarget)}\n\n${formatTime(target.scheduledAt)}`;
  await bot.api.sendMessage(draft.adminId, text, {
    reply_markup: new InlineKeyboard().text("Открыть", `video_open:${draft.id}`).text("Отменить", `video_cancel:${draft.id}`),
  });
  backendDb.db
    .update(videoDrafts)
    .set({ reminderSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(videoDrafts.id, draft.id))
    .run();
}

function completeVideoJob(backendDb: BackendDb, id: number): void {
  backendDb.db
    .update(videoJobs)
    .set({ status: "completed", lockedAt: null, lockedBy: null, updatedAt: new Date().toISOString() })
    .where(eq(videoJobs.id, id))
    .run();
}

function failVideoJob(backendDb: BackendDb, job: VideoJob, error: string, config: BackendConfig): void {
  const attempts = job.attemptCount + 1;
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
    if (job.videoTargetId)
      tx.update(videoTargets)
        .set({ status: retry ? "scheduled" : "failed", lastError: error, updatedAt: now })
        .where(eq(videoTargets.id, job.videoTargetId))
        .run();
  });
  refreshVideoDraftStatus(backendDb, job.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
}

function recoverVideoLocks(backendDb: BackendDb, timeoutSeconds: number): void {
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000).toISOString();
  backendDb.db
    .update(videoJobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null, updatedAt: new Date().toISOString() })
    .where(and(eq(videoJobs.status, "running"), lte(videoJobs.lockedAt, cutoff)))
    .run();
}

export function refreshVideoDraftStatus(backendDb: BackendDb, videoDraftId: number, retentionHours: number): void {
  const targets = listVideoTargets(backendDb, videoDraftId);
  if (targets.length === 0) return;
  const final = targets.every((target) => ["published", "failed", "cancelled"].includes(target.status));
  const status = final ? (targets.every((target) => target.status === "published") ? "published" : "partial") : "scheduled";
  backendDb.db
    .update(videoDrafts)
    .set({
      status,
      retentionUntil: final ? new Date(Date.now() + retentionHours * 60 * 60_000).toISOString() : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(videoDrafts.id, videoDraftId))
    .run();
}

function pruneExpiredVideos(config: BackendConfig, backendDb: BackendDb): void {
  const now = new Date().toISOString();
  const rows = backendDb.db
    .select()
    .from(videoDrafts)
    .where(
      and(
        lte(videoDrafts.retentionUntil, now),
        or(eq(videoDrafts.status, "published"), eq(videoDrafts.status, "partial"), eq(videoDrafts.status, "cancelled")),
      ),
    )
    .all();
  for (const row of rows) {
    deleteVideo(config, row.assetKey);
    backendDb.db.update(videoDrafts).set({ retentionUntil: null, updatedAt: now }).where(eq(videoDrafts.id, row.id)).run();
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]`])/g, "\\$1");
}

function formatTime(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow" }).format(new Date(value))
    : "время не задано";
}
