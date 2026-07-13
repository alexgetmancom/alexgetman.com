import { statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { socialComments, videoDrafts, videoJobs, videoMetricSchedule, videoMetricSnapshots, videoTargets } from "../db/schema.js";
import { isVideoTargetEditable, isVideoTargetSchedulable } from "../publishing/state.js";
import { formatVideoTime, getVideoDraft, insertVideoJob, listVideoTargets } from "./data.js";
import { videoPath } from "./storage.js";
import type { InstagramMetadata, VideoMetadata, VideoTarget, YouTubeMetadata } from "./types.js";
import { VIDEO_TARGETS } from "./types.js";

export { refreshVideoDraftStatus } from "./data.js";
export { runVideoCycle } from "./worker.js";

export function createVideoDraft(backendDb: BackendDb, adminId: number, assetKey: string, retentionHours: number): number {
  const now = new Date().toISOString();
  const retentionUntil = new Date(Date.now() + retentionHours * 60 * 60_000).toISOString();
  const row = backendDb.db
    .insert(videoDrafts)
    .values({
      adminId,
      assetKey,
      status: "editing",
      retentionUntil,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: videoDrafts.id })
    .get();
  if (!row) throw new Error("Could not create video draft.");
  return row.id;
}

export { listVideoTargets } from "./data.js";

export function updateVideoLabel(backendDb: BackendDb, id: number, label: string): void {
  backendDb.db.update(videoDrafts).set({ label: label.trim(), updatedAt: new Date().toISOString() }).where(eq(videoDrafts.id, id)).run();
}

export function setVideoControlCard(backendDb: BackendDb, id: number, chatId: number, messageId: number): void {
  backendDb.db
    .update(videoDrafts)
    .set({
      controlChatId: chatId,
      controlMessageId: messageId,
      updatedAt: new Date().toISOString(),
    })
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
    for (const target of allowed)
      tx.insert(videoTargets)
        .values({
          videoDraftId,
          target,
          metadataJson: {},
          status: "editing",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    tx.update(videoDrafts).set({ status: "editing", updatedAt: now }).where(eq(videoDrafts.id, videoDraftId)).run();
  });
}

export function saveVideoMetadata(backendDb: BackendDb, videoDraftId: number, target: VideoTarget, metadata: VideoMetadata): void {
  backendDb.db
    .update(videoTargets)
    .set({
      metadataJson: metadata as Record<string, unknown>,
      updatedAt: new Date().toISOString(),
    })
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
        .set({
          scheduledAt: publishAt,
          status: "scheduled",
          lastError: null,
          updatedAt: now.toISOString(),
        })
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
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
    }>;
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

export function videoPreview(backendDb: BackendDb, videoDraftId: number): { text: string; keyboard: InlineKeyboard } {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const targets = listVideoTargets(backendDb, videoDraftId);
  const title = draft.label || "Видеопубликация";
  const lines = [`🎬 *${escapeMarkdown(title)}*`, `Статус: *${videoStatusLabel(draft.status)}*`];
  const keyboard = new InlineKeyboard();
  const ytTarget = targets.find((target) => target.target === "youtube_shorts");
  const igTarget = targets.find((target) => target.target === "instagram_reels");
  if (ytTarget) {
    const metadata = (ytTarget.metadataJson ?? {}) as Partial<YouTubeMetadata>;
    lines.push("", "▶️ *YouTube Shorts*", `Название: ${escapeMarkdown(metadata.title || "—")}`);
    if (metadata.description) lines.push(`Описание: ${escapeMarkdown(metadata.description)}`);
    if (metadata.gameUrl) lines.push(`Игра: ${escapeMarkdown(metadata.gameUrl)}`);
    if (metadata.tags?.length) lines.push(`Теги: ${escapeMarkdown(metadata.tags.join(", "))}`);
    lines.push(
      `Состояние: ${videoStatusLabel(ytTarget.status)}${ytTarget.scheduledAt ? ` · ${formatVideoTime(ytTarget.scheduledAt)}` : ""}`,
    );
    if (isVideoTargetSchedulable(ytTarget.status)) keyboard.text("🕒 Время YouTube", `video_time:youtube_shorts:${draft.id}`);
    if (isVideoTargetEditable(ytTarget.status)) keyboard.text("❌ Убрать YouTube", `video_remove:youtube_shorts:${draft.id}`).row();
  }
  if (igTarget) {
    const metadata = (igTarget.metadataJson ?? {}) as Partial<InstagramMetadata>;
    lines.push(
      "",
      "📸 *Instagram Reels*",
      `Описание: ${escapeMarkdown(metadata.caption || "—")}`,
      `Состояние: ${videoStatusLabel(igTarget.status)}${igTarget.scheduledAt ? ` · ${formatVideoTime(igTarget.scheduledAt)}` : ""}`,
    );
    if (isVideoTargetSchedulable(igTarget.status)) keyboard.text("🕒 Время Instagram", `video_time:instagram_reels:${draft.id}`);
    if (isVideoTargetEditable(igTarget.status)) keyboard.text("❌ Убрать Instagram", `video_remove:instagram_reels:${draft.id}`).row();
    if (igTarget.status === "failed") keyboard.text("🔁 Повторить Instagram", `video_retry:instagram_reels:${draft.id}`).row();
  }
  if (ytTarget?.status === "failed") keyboard.text("🔁 Повторить YouTube", `video_retry:youtube_shorts:${draft.id}`).row();
  if (targets.length > 0 && (draft.status === "draft" || draft.status === "editing"))
    keyboard.text("📅 Запланировать", `video_schedule:${draft.id}`).row();
  keyboard.text("✏️ Изменить данные", `video_edit_menu:${draft.id}`);
  keyboard.text("🗑 Удалить видео", `video_cancel:${draft.id}`).row();
  keyboard.text("← К очереди", "queue_home");
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
      .where(and(eq(videoTargets.videoDraftId, videoDraftId), ne(videoTargets.status, "published")))
      .run();
    tx.update(videoDrafts)
      .set({
        status: "cancelled",
        retentionUntil: new Date(Date.now() + retentionHours * 60 * 60_000).toISOString(),
        updatedAt: now,
      })
      .where(eq(videoDrafts.id, videoDraftId))
      .run();
  });
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

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]`])/g, "\\$1");
}
