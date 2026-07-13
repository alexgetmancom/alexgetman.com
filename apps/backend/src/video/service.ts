import crypto from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import {
  botSettings,
  socialComments,
  videoDrafts,
  videoJobs,
  videoMetricSchedule,
  videoMetricSnapshots,
  videoTargets,
} from "../db/schema.js";
import { nextRetryAt } from "../queue/errors.js";
import { isVideoTargetEditable, isVideoTargetFinal, isVideoTargetSchedulable, videoDraftStatus } from "../services/publicationState.js";
import {
  InstagramContainerInvalidError,
  InstagramContainerProcessingError,
  instagramContainerReady,
  prepareInstagramReel,
  prepareYouTubeVideo,
  publishInstagramReel,
} from "./publishers.js";
import { deleteVideo, videoPath } from "./storage.js";
import type { InstagramMetadata, VideoMetadata, VideoTarget, YouTubeMetadata } from "./types.js";
import { VIDEO_TARGETS, videoTargetLabel } from "./types.js";

type VideoDraft = typeof videoDrafts.$inferSelect;
type VideoTargetRow = typeof videoTargets.$inferSelect;
type VideoJob = typeof videoJobs.$inferSelect;
type JobKind = "prepare" | "publish" | "reminder";

export function createVideoDraft(backendDb: BackendDb, adminId: number, assetKey: string, retentionHours: number): number {
  const now = new Date().toISOString();
  const retentionUntil = new Date(Date.now() + retentionHours * 60 * 60_000).toISOString();
  const row = backendDb.db
    .insert(videoDrafts)
    .values({ adminId, assetKey, status: "editing", retentionUntil, createdAt: now, updatedAt: now })
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
    const existingIds = tx
      .select({ id: videoTargets.id })
      .from(videoTargets)
      .where(eq(videoTargets.videoDraftId, videoDraftId))
      .all()
      .map((target) => target.id);
    // SQLite's historical schema has no cascading foreign keys. Keep every
    // dependent table in sync before replacing editable targets.
    if (existingIds.length > 0) {
      tx.delete(socialComments).where(inArray(socialComments.videoTargetId, existingIds)).run();
      tx.delete(videoMetricSnapshots).where(inArray(videoMetricSnapshots.videoTargetId, existingIds)).run();
      tx.delete(videoMetricSchedule).where(inArray(videoMetricSchedule.videoTargetId, existingIds)).run();
    }
    tx.delete(videoJobs).where(eq(videoJobs.videoDraftId, videoDraftId)).run();
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
  const selectedTargets = targets.filter((target) => schedule[target.target as VideoTarget] != null);
  if (selectedTargets.length === 0) throw new Error("Choose at least one video platform to schedule.");
  for (const target of selectedTargets) {
    const date = schedule[target.target as VideoTarget];
    if (!date || Number.isNaN(date.getTime()) || date.getTime() <= now.getTime())
      throw new Error("Publication time must be in the future.");
  }
  backendDb.db.transaction((tx) => {
    for (const target of selectedTargets) {
      const targetSchedule = schedule[target.target as VideoTarget];
      if (!targetSchedule) continue;
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
    const activeSchedules = tx
      .select({ scheduledAt: videoTargets.scheduledAt })
      .from(videoTargets)
      .where(and(eq(videoTargets.videoDraftId, videoDraftId), ne(videoTargets.status, "published"), ne(videoTargets.status, "cancelled")))
      .all()
      .flatMap((target) => (target.scheduledAt ? [new Date(target.scheduledAt).getTime()] : []));
    const common = activeSchedules.length > 0 ? Math.min(...activeSchedules) : null;
    tx.update(videoDrafts)
      .set({
        status: "scheduled",
        scheduledAt: common == null ? null : new Date(common).toISOString(),
        reminderSentAt: null,
        retentionUntil: null,
        updatedAt: now.toISOString(),
      })
      .where(eq(videoDrafts.id, videoDraftId))
      .run();
  });
}

/** Requeues only the failed platform; the other platform and its media stay untouched. */
export function retryFailedVideoTarget(backendDb: BackendDb, videoDraftId: number, targetName: VideoTarget): void {
  const target = backendDb.db
    .select()
    .from(videoTargets)
    .where(and(eq(videoTargets.videoDraftId, videoDraftId), eq(videoTargets.target, targetName)))
    .get();
  if (target?.status !== "failed") throw new Error("Повторить можно только площадку с ошибкой.");
  const now = new Date();
  const nowIso = now.toISOString();
  backendDb.db.transaction((tx) => {
    const reusePreparedYouTube = targetName === "youtube_shorts" && Boolean(target.externalId);
    tx.update(videoTargets)
      .set({
        status: reusePreparedYouTube ? "prepared" : "scheduled",
        ...(reusePreparedYouTube ? {} : { externalId: null, externalUrl: null, preparedAt: null }),
        lastError: null,
        updatedAt: nowIso,
      })
      .where(eq(videoTargets.id, target.id))
      .run();
    if (!reusePreparedYouTube) insertVideoJob(tx, videoDraftId, target.id, "prepare", nowIso);
    insertVideoJob(tx, videoDraftId, target.id, "publish", new Date(now.getTime() + 60_000).toISOString());
    tx.update(videoDrafts)
      .set({ status: "scheduled", retentionUntil: null, updatedAt: nowIso })
      .where(eq(videoDrafts.id, videoDraftId))
      .run();
  });
}

type VideoTechnicalCheck = { summary: string; warning: string | null };

export async function validateVideoDraft(config: BackendConfig, backendDb: BackendDb, videoDraftId: number): Promise<VideoTechnicalCheck> {
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
  return probeVideo(source, size);
}

async function probeVideo(source: string, size: number): Promise<VideoTechnicalCheck> {
  const child = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate",
      "-of",
      "json",
      source,
    ],
    { stdout: "pipe" },
  );
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error("Не удалось проверить видео через ffprobe. Отправьте MP4 ещё раз.");
  const data = JSON.parse(output) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>;
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  if (!video?.width || !video.height) throw new Error("В MP4 не найден видеопоток.");
  const [a = 0, b = 1] = (video.avg_frame_rate ?? "0/1").split("/").map(Number);
  const fps = b ? a / b : 0;
  const seconds = Math.max(0, Math.round(Number(data.format?.duration ?? 0)));
  const warning =
    Math.abs(video.width / video.height - 9 / 16) > 0.02 ? "⚠️ Формат не 9:16: платформы могут обрезать ролик или добавить поля." : null;
  return {
    summary: `🔎 Проверка видео: ${video.width}×${video.height}, ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}, ${(video.codec_name ?? "video").toUpperCase()}/${(audio?.codec_name ?? "без звука").toUpperCase()}, ${audio ? "звук есть" : "без звука"}, ${fps ? `${fps.toFixed(0)} FPS` : "FPS неизвестен"}, ${Math.ceil(size / 1024 / 1024)} МБ — подходит.`,
    warning,
  };
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
  const title = draft.label || "Видеопубликация";
  const lines = [`🎬 *${escapeMarkdown(title)}*`, `Статус: *${videoStatusLabel(draft.status)}*`];
  const keyboard = new InlineKeyboard();
  const ytTarget = targets.find((t) => t.target === "youtube_shorts");
  const igTarget = targets.find((t) => t.target === "instagram_reels");

  if (ytTarget) {
    const metadata = (ytTarget.metadataJson ?? {}) as Partial<YouTubeMetadata>;
    lines.push("", "▶️ *YouTube Shorts*");
    lines.push(`Название: ${escapeMarkdown(metadata.title || "—")}`);
    if (metadata.description) lines.push(`Описание: ${escapeMarkdown(metadata.description)}`);
    if (metadata.gameUrl) lines.push(`Игра: ${escapeMarkdown(metadata.gameUrl)}`);
    if (metadata.tags?.length) lines.push(`Теги: ${escapeMarkdown(metadata.tags.join(", "))}`);
    lines.push(`Состояние: ${videoStatusLabel(ytTarget.status)}${ytTarget.scheduledAt ? ` · ${formatTime(ytTarget.scheduledAt)}` : ""}`);
    if (isVideoTargetSchedulable(ytTarget.status)) keyboard.text("🕒 Время YouTube", `video_time:youtube_shorts:${draft.id}`);
    if (isVideoTargetEditable(ytTarget.status)) keyboard.text("❌ Убрать YouTube", `video_remove:youtube_shorts:${draft.id}`).row();
  }
  if (igTarget) {
    const metadata = (igTarget.metadataJson ?? {}) as Partial<InstagramMetadata>;
    lines.push("", "📸 *Instagram Reels*");
    lines.push(`Описание: ${escapeMarkdown(metadata.caption || "—")}`);
    lines.push(`Состояние: ${videoStatusLabel(igTarget.status)}${igTarget.scheduledAt ? ` · ${formatTime(igTarget.scheduledAt)}` : ""}`);
    if (isVideoTargetSchedulable(igTarget.status)) keyboard.text("🕒 Время Instagram", `video_time:instagram_reels:${draft.id}`);
    if (isVideoTargetEditable(igTarget.status)) keyboard.text("❌ Убрать Instagram", `video_remove:instagram_reels:${draft.id}`).row();
    if (igTarget.status === "failed") keyboard.text("🔁 Повторить Instagram", `video_retry:instagram_reels:${draft.id}`).row();
  }
  if (ytTarget?.status === "failed") keyboard.text("🔁 Повторить YouTube", `video_retry:youtube_shorts:${draft.id}`).row();
  if (targets.length > 0 && (draft.status === "draft" || draft.status === "editing")) {
    keyboard.text("📅 Запланировать", `video_schedule:${draft.id}`).row();
  }

  keyboard.text("✏️ Изменить данные", `video_edit_menu:${draft.id}`);
  keyboard.text("🗑 Удалить видео", `video_cancel:${draft.id}`).row();
  keyboard.text("← К очереди", "queue_home");

  return { text: lines.join("\n"), keyboard };
}

function videoStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    editing: "заполняется",
    draft: "черновик",
    scheduled: "запланировано",
    preparing: "подготовка",
    prepared: "готово к публикации",
    publishing: "публикуется",
    published: "опубликовано",
    failed: "ошибка",
    cancelled: "отменено",
  };
  return labels[status] ?? status;
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
      .where(and(eq(videoTargets.videoDraftId, videoDraftId), ne(videoTargets.status, "published")))
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
  const text = `⏰ Через ${reminderMinutes} мин. публикация:\n\n🎬 ${draft.label || "Без названия"}\n• ${videoTargetLabel(target.target as VideoTarget)}\n\n${formatTime(target.scheduledAt)}`;
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
        .set({ status: "scheduled", externalId: null, externalUrl: null, preparedAt: null, lastError: error, updatedAt: now })
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
        .set({ status: retry ? "scheduled" : "failed", lastError: error, updatedAt: now })
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
    .set({ status: "queued", lockedAt: null, lockedBy: null, updatedAt: new Date().toISOString() })
    .where(and(eq(videoJobs.status, "running"), lte(videoJobs.lockedAt, cutoff)))
    .run();
}

export function refreshVideoDraftStatus(backendDb: BackendDb, videoDraftId: number, retentionHours: number): void {
  const targets = listVideoTargets(backendDb, videoDraftId);
  if (targets.length === 0) return;
  const final = targets.every((target) => isVideoTargetFinal(target.status));
  const status = videoDraftStatus(targets.map((target) => target.status));
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
  // Old drafts created before draft retention was introduced have no deadline.
  // Treat them as expired after the same retention interval from their creation.
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
      .set({ status: row.status === "editing" ? "cancelled" : row.status, retentionUntil: null, updatedAt: now })
      .where(eq(videoDrafts.id, row.id))
      .run();
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
