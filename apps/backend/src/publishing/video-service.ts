import { statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { videoSourcePath } from "../content/video-assets.js";
import type { BackendDb } from "../db/client.js";
import { videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { isZernioRouteReady, videoDeliveryRoute } from "./delivery-provider.js";
import { isVideoTargetEditable } from "./state.js";
import { getVideoDraft, insertVideoJob, listVideoTargets, refreshVideoDraftStatus } from "./video-data.js";
import type { VideoMetadata, VideoTarget } from "./video-types.js";
import { VIDEO_TARGETS } from "./video-types.js";

export function createVideoDraft(
  backendDb: BackendDb,
  adminId: number,
  source: string | { studioMediaAssetId: number },
  retentionHours: number,
): number {
  const now = new Date().toISOString();
  const retentionUntil = new Date(Date.now() + retentionHours * 60 * 60_000).toISOString();
  const row = backendDb.db
    .insert(videoDrafts)
    .values({
      adminId,
      assetKey: typeof source === "string" ? source : `studio-asset-${source.studioMediaAssetId}`,
      ...(typeof source === "string" ? {} : { studioMediaAssetId: source.studioMediaAssetId }),
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

export function updateVideoLabel(backendDb: BackendDb, id: number, label: string): void {
  backendDb.db.update(videoDrafts).set({ label: label.trim(), updatedAt: new Date().toISOString() }).where(eq(videoDrafts.id, id)).run();
}

export function replaceVideoTargets(backendDb: BackendDb, videoDraftId: number, targets: VideoTarget[]): void {
  const allowed = targets.filter((target, index) => VIDEO_TARGETS.includes(target) && targets.indexOf(target) === index);
  if (allowed.length === 0) throw new Error("Choose at least one video platform.");
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    const existingTargets = tx.select().from(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).all();
    if (existingTargets.some((target) => !isVideoTargetEditable(target.status)))
      throw new Error("Video platforms can be replaced only before scheduling. Remove an editable platform instead.");
    // Foreign keys cascade (PRAGMA foreign_keys=ON, migration 0008): deleting the
    // target rows removes their comments, metric snapshots and schedules. Reminder
    // jobs carry a null target, so the draft's jobs are cleared explicitly.
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

/** Removes one editable target and every dependent job/metric row atomically. */
export function removeVideoTarget(backendDb: BackendDb, videoDraftId: number, targetName: VideoTarget, retentionHours: number): boolean {
  const target = backendDb.db
    .select()
    .from(videoTargets)
    .where(and(eq(videoTargets.videoDraftId, videoDraftId), eq(videoTargets.target, targetName)))
    .get();
  if (!target) throw new Error("Video platform was not found.");
  if (!isVideoTargetEditable(target.status)) throw new Error("This video platform can no longer be removed.");

  const now = new Date().toISOString();
  const remaining = backendDb.db.transaction((tx) => {
    // FK cascade (see replaceVideoTargets): removing the target row deletes its
    // comments, metric snapshots, schedule and platform jobs.
    tx.delete(videoTargets).where(eq(videoTargets.id, target.id)).run();
    const remainingTargets = tx.select({ id: videoTargets.id }).from(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).all();
    if (remainingTargets.length === 0)
      tx.update(videoDrafts)
        .set({
          status: "cancelled",
          retentionUntil: new Date(Date.now() + retentionHours * 60 * 60_000).toISOString(),
          updatedAt: now,
        })
        .where(eq(videoDrafts.id, videoDraftId))
        .run();
    return remainingTargets.length;
  });
  if (remaining > 0) refreshVideoDraftStatus(backendDb, videoDraftId, retentionHours);
  return remaining === 0;
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
  config?: BackendConfig,
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
      const route = config ? videoDeliveryRoute(config, target.target as VideoTarget) : { provider: "native" as const };
      tx.update(videoTargets)
        .set({
          scheduledAt: publishAt,
          status: "scheduled",
          lastError: null,
          deliveryProvider: route.provider,
          providerAccountId: route.accountId ?? null,
          updatedAt: now.toISOString(),
        })
        .where(eq(videoTargets.id, target.id))
        .run();
      insertVideoJob(tx, videoDraftId, target.id, "prepare", preparedAt.toISOString());
      insertVideoJob(tx, videoDraftId, target.id, "publish", publishAt);
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
  if (target?.status !== "failed") throw new StudioError("err.retry-only-failed");
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

export type VideoTechnicalCheck = {
  width: number;
  height: number;
  seconds: number;
  videoCodec: string;
  audioCodec: string | null;
  fps: number;
  sizeBytes: number;
  aspectOk: boolean;
};

export async function validateVideoDraft(config: BackendConfig, backendDb: BackendDb, videoDraftId: number): Promise<VideoTechnicalCheck> {
  const draft = getVideoDraft(backendDb, videoDraftId);
  const source = videoSourcePath(backendDb, config, draft);
  if (!source) throw new StudioError("err.source-missing");
  if (path.extname(source).toLowerCase() !== ".mp4") throw new StudioError("err.need-mp4");
  const size = statSync(source).size;
  if (size <= 0) throw new StudioError("err.video-empty");
  if (size > config.VIDEO_MAX_BYTES)
    throw new StudioError("err.video-too-big", {
      size: Math.ceil(size / 1024 / 1024),
      limit: Math.floor(config.VIDEO_MAX_BYTES / 1024 / 1024),
    });
  for (const target of listVideoTargets(backendDb, videoDraftId)) {
    if (target.target === "youtube_shorts" && (!config.YOUTUBE_CLIENT_ID || !config.YOUTUBE_CLIENT_SECRET || !config.YOUTUBE_REFRESH_TOKEN))
      throw new StudioError("err.youtube-not-configured");
    if (target.target === "instagram_reels") {
      const route = videoDeliveryRoute(config, "instagram_reels");
      if (!isZernioRouteReady(config, route) && route.provider === "zernio") throw new StudioError("err.instagram-not-configured");
      if (route.provider === "native" && (!config.INSTAGRAM_ACCESS_TOKEN || !config.INSTAGRAM_USER_ID))
        throw new StudioError("err.instagram-not-configured");
    }
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
  if ((await child.exited) !== 0) throw new StudioError("err.ffprobe-failed");
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
  if (!video?.width || !video.height) throw new StudioError("err.no-video-stream");
  const [a = 0, b = 1] = (video.avg_frame_rate ?? "0/1").split("/").map(Number);
  const fps = b ? a / b : 0;
  const seconds = Math.max(0, Math.round(Number(data.format?.duration ?? 0)));
  return {
    width: video.width,
    height: video.height,
    seconds,
    videoCodec: video.codec_name ?? "video",
    audioCodec: audio?.codec_name ?? null,
    fps,
    sizeBytes: size,
    aspectOk: Math.abs(video.width / video.height - 9 / 16) <= 0.02,
  };
}

type VideoCancellation = {
  /** Already-public targets are deliberately not deleted by automation. */
  manualRemoval: Array<{ target: VideoTarget; url: string | null }>;
  /** Private scheduled uploads which can be safely kept private. */
  holdPrivateYouTubeIds: string[];
};

export function cancelVideo(backendDb: BackendDb, videoDraftId: number, retentionHours: number): VideoCancellation {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const targets = listVideoTargets(backendDb, videoDraftId);
  const manualRemoval = targets
    .filter((target) => target.status === "published")
    .map((target) => ({ target: target.target as VideoTarget, url: target.externalUrl }));
  const holdPrivateYouTubeIds = targets
    .filter(
      (target) =>
        target.target === "youtube_shorts" &&
        target.status !== "published" &&
        target.externalId != null &&
        target.scheduledAt != null &&
        new Date(target.scheduledAt).getTime() > nowMs,
    )
    .map((target) => target.externalId as string);
  backendDb.db.transaction((tx) => {
    tx.update(videoJobs)
      .set({ status: "cancelled", lockedAt: null, lockedBy: null, updatedAt: now })
      .where(and(eq(videoJobs.videoDraftId, videoDraftId), inArray(videoJobs.status, ["queued", "running"])))
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
  return { manualRemoval, holdPrivateYouTubeIds };
}
