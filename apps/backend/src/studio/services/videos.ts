import { requireStudioMediaAssets } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import { keepYouTubeUploadPrivate } from "../../delivery/video-publishers.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { parseManualSchedule, scheduleClockToday } from "../../publishing/schedule.js";
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
import type { VideoLocale, VideoMetadata, VideoTarget } from "../../publishing/video-types.js";
import { accessibleStudioActorIds, canAccessStudioOwner } from "../access.js";
import { videoDeliveryProjections } from "../projections.js";
import { settingsService } from "./settings.js";

/** Video publication command boundary for Telegram Studio, Web Studio and MCP. */
export function videoService(backendDb: BackendDb, config: BackendConfig) {
  return {
    create(actorId: number, studioMediaAssetId: number, locale: VideoLocale = "ru"): number {
      const [asset] = requireStudioMediaAssets(backendDb, actorId, [studioMediaAssetId], accessibleStudioActorIds(config, actorId));
      if (asset?.kind !== "video") throw new StudioError("err.video-needs-asset");
      return createVideoDraft(backendDb, actorId, { studioMediaAssetId }, config.VIDEO_MEDIA_RETENTION_HOURS, locale);
    },
    get(actorId: number, videoDraftId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      return { draft, targets: backendDb.studioVideos.targets(videoDraftId) };
    },
    list(actorId: number, limit = 50) {
      return backendDb.studioVideos.list(accessibleStudioActorIds(config, actorId), limit);
    },
    async schedule(actorId: number, videoDraftId: number, schedule: Partial<Record<VideoTarget, Date>>) {
      return scheduleOwnedVideo(backendDb, config, actorId, videoDraftId, schedule);
    },
    async validate(actorId: number, videoDraftId: number) {
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      return validateVideoDraft(config, backendDb, videoDraftId);
    },
    async publish(actorId: number, videoDraftId: number) {
      // Access first: otherwise an outsider's draft answers "choose platforms"
      // instead of "not yours", which leaks whether it exists and how it looks.
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      const targets = backendDb.studioVideos.targets(videoDraftId).map((row) => row.target as VideoTarget);
      if (!targets.length) throw new StudioError("err.video-choose-platforms");
      const schedule = Object.fromEntries(targets.map((target) => [target, new Date(Date.now() + 60_000)])) as Partial<
        Record<VideoTarget, Date>
      >;
      return scheduleOwnedVideo(backendDb, config, actorId, videoDraftId, schedule);
    },
    retry(actorId: number, videoDraftId: number, target: VideoTarget): void {
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      retryFailedVideoTarget(backendDb, videoDraftId, target);
    },
    async cancel(actorId: number, videoDraftId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      const cancellation = cancelVideo(backendDb, videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
      cancelScheduledNotifications(backendDb, `video:${videoDraftId}`);
      const heldPrivateYouTubeIds: string[] = [];
      const holdFailures: string[] = [];
      for (const videoId of cancellation.holdPrivateYouTubeIds) {
        try {
          await keepYouTubeUploadPrivate(config, videoId, draft.locale === "en" ? "en" : "ru");
          heldPrivateYouTubeIds.push(videoId);
        } catch (error) {
          holdFailures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (cancellation.manualRemoval.length || holdFailures.length) {
        recordDomainEvent(backendDb.events, {
          ref: `video:${videoDraftId}`,
          type: "studio.notification.video_cancelled",
          severity: holdFailures.length ? "warn" : "info",
          message: cancellation.manualRemoval.length
            ? `Video #${videoDraftId} was cancelled locally; published targets require manual removal.`
            : `Video #${videoDraftId} was cancelled locally; YouTube schedule needs attention.`,
          details: {
            manual_removal: cancellation.manualRemoval,
            held_private_youtube_ids: heldPrivateYouTubeIds,
            hold_failures: holdFailures,
          },
        });
      }
      return { ...cancellation, heldPrivateYouTubeIds, holdFailures };
    },
    preview(actorId: number, videoDraftId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      return { draft, targets: backendDb.studioVideos.targets(videoDraftId), delivery: videoDeliveryProjections(backendDb, videoDraftId) };
    },
    status(actorId: number, videoDraftId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      return {
        draft,
        targets: backendDb.studioVideos.targets(videoDraftId),
        jobs: backendDb.studioVideos.jobs(videoDraftId),
      };
    },
    history(actorId: number, videoDraftId: number, limit = 50) {
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      return backendDb.studioVideos.history(`video:${videoDraftId}`, limit);
    },
    updateMetadata(actorId: number, videoDraftId: number, target: VideoTarget, metadata: VideoMetadata): void {
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      saveVideoMetadata(backendDb, videoDraftId, target, metadata);
    },
    rename(actorId: number, videoDraftId: number, label: string): void {
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      updateVideoLabel(backendDb, videoDraftId, label);
    },
    replaceTargets(actorId: number, videoDraftId: number, targets: VideoTarget[]): void {
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      replaceVideoTargets(backendDb, videoDraftId, targets);
    },
    removeTarget(actorId: number, videoDraftId: number, target: VideoTarget): { cancelled: boolean } {
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      return { cancelled: removeVideoTarget(backendDb, videoDraftId, target, config.VIDEO_MEDIA_RETENTION_HOURS) };
    },
    parseSchedule(actorId: number, videoDraftId: number, value: string): Date {
      requireOwnedVideo(backendDb, config, actorId, videoDraftId);
      return parseManualSchedule(value, config.TIMEZONE, backendDb.clock.now());
    },
    /** Resolves a slot-button clock (`HH:MM` in the configured Studio zone) to its next occurrence. */
    slotTime(clock: string): Date {
      return scheduleClockToday(clock, config.TIMEZONE, backendDb.clock.now());
    },
  };
}

/** Shared by `schedule` (explicit times) and `publish` (schedule ~now): both
 * validate the source, write the schedule and arm reminders identically. */
async function scheduleOwnedVideo(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  videoDraftId: number,
  schedule: Partial<Record<VideoTarget, Date>>,
) {
  const draft = requireOwnedVideo(backendDb, config, actorId, videoDraftId);
  const technical = await validateVideoDraft(config, backendDb, videoDraftId);
  scheduleVideo(
    backendDb,
    videoDraftId,
    schedule,
    { prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES, reminderMinutes: config.VIDEO_REMINDER_MINUTES },
    config,
    technical.seconds,
  );
  scheduleVideoReminders(backendDb, draft.actorId, videoDraftId, draft.label);
  return technical;
}

function scheduleVideoReminders(backendDb: BackendDb, ownerId: number, videoDraftId: number, label: string): void {
  cancelScheduledNotifications(backendDb, `video:${videoDraftId}`);
  const preference = settingsService(backendDb).notifications(ownerId);
  const grouped = new Map<string, VideoTarget[]>();
  for (const target of backendDb.studioVideos.targets(videoDraftId)) {
    if (!target.scheduledAt || ["published", "cancelled", "failed", "verification_required"].includes(target.status)) continue;
    const targets = grouped.get(target.scheduledAt) ?? [];
    targets.push(target.target as VideoTarget);
    grouped.set(target.scheduledAt, targets);
  }
  for (const [publishAt, targets] of grouped) {
    scheduleReminder(backendDb, {
      actorId: ownerId,
      ref: `video:${videoDraftId}`,
      kind: `video.${publishAt}`,
      publishAt: new Date(publishAt),
      title: label || `Video #${videoDraftId}`,
      targets,
      preference,
    });
  }
}

function requireOwnedVideo(backendDb: BackendDb, config: BackendConfig, actorId: number, videoDraftId: number) {
  const draft = backendDb.studioVideos.get(videoDraftId);
  if (!draft) throw new Error("Video publication was not found.");
  if (!canAccessStudioOwner(config, actorId, draft.actorId)) throw new StudioError("err.video-not-yours");
  return draft;
}
