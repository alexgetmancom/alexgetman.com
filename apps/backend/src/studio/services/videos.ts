import { desc, eq } from "drizzle-orm";
import { requireStudioMediaAssets } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import { postEvents, videoDrafts, videoJobs } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { parseManualSchedule } from "../../publishing/schedule.js";
import { getVideoDraft, listVideoTargets } from "../../publishing/video-data.js";
import {
  cancelVideo,
  createVideoDraft,
  removeVideoTarget,
  replaceVideoTargets,
  retryFailedVideoTarget,
  saveVideoMetadata,
  scheduleVideo,
  updateVideoLabel,
  validateVideoDraft,
} from "../../publishing/video-service.js";
import type { VideoMetadata, VideoTarget } from "../../publishing/video-types.js";

type VideoEditInput = { label?: string; target?: VideoTarget; metadata?: VideoMetadata };

/** Video publication command boundary for Telegram Studio, Web Studio and MCP. */
export function videoService(backendDb: BackendDb, config: BackendConfig) {
  return {
    create(actorId: number, studioMediaAssetId: number): number {
      const [asset] = requireStudioMediaAssets(backendDb, actorId, [studioMediaAssetId]);
      if (asset?.kind !== "video") throw new Error("Video Studio requires an owned MP4 media asset.");
      return createVideoDraft(backendDb, actorId, { studioMediaAssetId }, config.VIDEO_MEDIA_RETENTION_HOURS);
    },
    get(actorId: number, videoDraftId: number) {
      const draft = requireOwnedVideo(backendDb, actorId, videoDraftId);
      return { draft, targets: listVideoTargets(backendDb, videoDraftId) };
    },
    list(actorId: number, limit = 50) {
      return backendDb.db
        .select()
        .from(videoDrafts)
        .where(eq(videoDrafts.adminId, actorId))
        .orderBy(desc(videoDrafts.updatedAt))
        .limit(limit)
        .all();
    },
    async schedule(actorId: number, videoDraftId: number, schedule: Partial<Record<VideoTarget, Date>>) {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      const technical = await validateVideoDraft(config, backendDb, videoDraftId);
      scheduleVideo(backendDb, videoDraftId, schedule, {
        prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES,
        reminderMinutes: config.VIDEO_REMINDER_MINUTES,
      });
      return technical;
    },
    async validate(actorId: number, videoDraftId: number) {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      return validateVideoDraft(config, backendDb, videoDraftId);
    },
    async publish(actorId: number, videoDraftId: number) {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      const targets = listVideoTargets(backendDb, videoDraftId).map((row) => row.target as VideoTarget);
      if (!targets.length) throw new Error("Choose video platforms first.");
      const technical = await validateVideoDraft(config, backendDb, videoDraftId);
      scheduleVideo(backendDb, videoDraftId, Object.fromEntries(targets.map((target) => [target, new Date(Date.now() + 60_000)])), {
        prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES,
        reminderMinutes: config.VIDEO_REMINDER_MINUTES,
      });
      return technical;
    },
    retry(actorId: number, videoDraftId: number, target: VideoTarget): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      retryFailedVideoTarget(backendDb, videoDraftId, target);
    },
    cancel(actorId: number, videoDraftId: number): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      cancelVideo(backendDb, videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
    },
    preview(actorId: number, videoDraftId: number) {
      const draft = requireOwnedVideo(backendDb, actorId, videoDraftId);
      return { draft, targets: listVideoTargets(backendDb, videoDraftId) };
    },
    status(actorId: number, videoDraftId: number) {
      const draft = requireOwnedVideo(backendDb, actorId, videoDraftId);
      return {
        draft,
        targets: listVideoTargets(backendDb, videoDraftId),
        jobs: backendDb.db.select().from(videoJobs).where(eq(videoJobs.videoDraftId, videoDraftId)).orderBy(desc(videoJobs.id)).all(),
      };
    },
    history(actorId: number, videoDraftId: number, limit = 50) {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      return backendDb.db
        .select()
        .from(postEvents)
        .where(eq(postEvents.postKey, `video:${videoDraftId}`))
        .orderBy(desc(postEvents.createdAt), desc(postEvents.id))
        .limit(limit)
        .all();
    },
    updateMetadata(actorId: number, videoDraftId: number, target: VideoTarget, metadata: VideoMetadata): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      saveVideoMetadata(backendDb, videoDraftId, target, metadata);
    },
    edit(actorId: number, videoDraftId: number, input: VideoEditInput): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      if (input.label != null) updateVideoLabel(backendDb, videoDraftId, input.label);
      if (input.target && input.metadata) saveVideoMetadata(backendDb, videoDraftId, input.target, input.metadata);
      if (input.label == null && (!input.target || !input.metadata)) throw new Error("No video fields supplied for editing.");
    },
    rename(actorId: number, videoDraftId: number, label: string): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      updateVideoLabel(backendDb, videoDraftId, label);
    },
    replaceTargets(actorId: number, videoDraftId: number, targets: VideoTarget[]): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      replaceVideoTargets(backendDb, videoDraftId, targets);
    },
    removeTarget(actorId: number, videoDraftId: number, target: VideoTarget): { cancelled: boolean } {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      return { cancelled: removeVideoTarget(backendDb, videoDraftId, target, config.VIDEO_MEDIA_RETENTION_HOURS) };
    },
    parseSchedule(actorId: number, videoDraftId: number, value: string): Date {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      return parseManualSchedule(value);
    },
  };
}

function requireOwnedVideo(backendDb: BackendDb, actorId: number, videoDraftId: number) {
  const draft = getVideoDraft(backendDb, videoDraftId);
  if (draft.adminId !== actorId) throw new Error("Video draft is not available to this user.");
  return draft;
}
