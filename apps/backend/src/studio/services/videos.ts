import type { BackendDb } from "../../db/client.js";
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
  setVideoControlCard,
  updateVideoLabel,
  validateVideoDraft,
} from "../../publishing/video-service.js";
import type { VideoMetadata, VideoTarget } from "../../publishing/video-types.js";

/** Video publication command boundary for Telegram Studio, Web Studio and MCP. */
export function videoService(backendDb: BackendDb, config: BackendConfig) {
  return {
    create(actorId: number, assetKey: string): number {
      return createVideoDraft(backendDb, actorId, assetKey, config.VIDEO_MEDIA_RETENTION_HOURS);
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
    /** Validate an owned source and configured targets without creating jobs. */
    async preflight(actorId: number, videoDraftId: number) {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      return validateVideoDraft(config, backendDb, videoDraftId);
    },
    /** Immediate publication is still a schedule, but the time policy belongs to Studio—not Telegram. */
    async publishNow(actorId: number, videoDraftId: number) {
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
    details(actorId: number, videoDraftId: number) {
      const draft = requireOwnedVideo(backendDb, actorId, videoDraftId);
      return { draft, targets: listVideoTargets(backendDb, videoDraftId) };
    },
    updateMetadata(actorId: number, videoDraftId: number, target: VideoTarget, metadata: VideoMetadata): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      saveVideoMetadata(backendDb, videoDraftId, target, metadata);
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
    setControlCard(actorId: number, videoDraftId: number, chatId: number, messageId: number): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      setVideoControlCard(backendDb, videoDraftId, chatId, messageId);
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
