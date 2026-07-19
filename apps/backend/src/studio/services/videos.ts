import { desc, eq } from "drizzle-orm";
import { requireStudioMediaAssets } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import { postEvents, studioNotificationSettings, videoDrafts, videoJobs } from "../../db/schema.js";
import { keepYouTubeUploadPrivate } from "../../delivery/video-publishers.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
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
import { videoDeliveryProjections } from "../projections.js";

type VideoEditInput = { label?: string; target?: VideoTarget; metadata?: VideoMetadata };

/** Video publication command boundary for Telegram Studio, Web Studio and MCP. */
export function videoService(backendDb: BackendDb, config: BackendConfig) {
  return {
    create(actorId: number, studioMediaAssetId: number): number {
      const [asset] = requireStudioMediaAssets(backendDb, actorId, [studioMediaAssetId]);
      if (asset?.kind !== "video") throw new StudioError("err.video-needs-asset");
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
      return scheduleOwnedVideo(backendDb, config, actorId, videoDraftId, schedule);
    },
    async validate(actorId: number, videoDraftId: number) {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      return validateVideoDraft(config, backendDb, videoDraftId);
    },
    async publish(actorId: number, videoDraftId: number) {
      const targets = listVideoTargets(backendDb, videoDraftId).map((row) => row.target as VideoTarget);
      if (!targets.length) throw new StudioError("err.video-choose-platforms");
      const schedule = Object.fromEntries(targets.map((target) => [target, new Date(Date.now() + 60_000)])) as Partial<
        Record<VideoTarget, Date>
      >;
      return scheduleOwnedVideo(backendDb, config, actorId, videoDraftId, schedule);
    },
    retry(actorId: number, videoDraftId: number, target: VideoTarget): void {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      retryFailedVideoTarget(backendDb, videoDraftId, target);
    },
    async cancel(actorId: number, videoDraftId: number) {
      requireOwnedVideo(backendDb, actorId, videoDraftId);
      const cancellation = cancelVideo(backendDb, videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
      cancelScheduledNotifications(backendDb, `video:${videoDraftId}`);
      const heldPrivateYouTubeIds: string[] = [];
      const holdFailures: string[] = [];
      for (const videoId of cancellation.holdPrivateYouTubeIds) {
        try {
          await keepYouTubeUploadPrivate(config, videoId);
          heldPrivateYouTubeIds.push(videoId);
        } catch (error) {
          holdFailures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (cancellation.manualRemoval.length || holdFailures.length) {
        recordDomainEvent(backendDb, {
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
      const draft = requireOwnedVideo(backendDb, actorId, videoDraftId);
      return { draft, targets: listVideoTargets(backendDb, videoDraftId), delivery: videoDeliveryProjections(backendDb, videoDraftId) };
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
      if (input.label == null && (!input.target || !input.metadata)) throw new StudioError("err.video-no-edit-fields");
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

/** Shared by `schedule` (explicit times) and `publish` (schedule ~now): both
 * validate the source, write the schedule and arm reminders identically. */
async function scheduleOwnedVideo(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  videoDraftId: number,
  schedule: Partial<Record<VideoTarget, Date>>,
) {
  const draft = requireOwnedVideo(backendDb, actorId, videoDraftId);
  const technical = await validateVideoDraft(config, backendDb, videoDraftId);
  scheduleVideo(
    backendDb,
    videoDraftId,
    schedule,
    { prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES, reminderMinutes: config.VIDEO_REMINDER_MINUTES },
    config,
  );
  scheduleVideoReminders(backendDb, actorId, videoDraftId, draft.label, schedule);
  return technical;
}

function scheduleVideoReminders(
  backendDb: BackendDb,
  actorId: number,
  videoDraftId: number,
  label: string,
  schedule: Partial<Record<VideoTarget, Date>>,
): void {
  const row = backendDb.db.select().from(studioNotificationSettings).where(eq(studioNotificationSettings.adminId, actorId)).get();
  const preference = {
    remindersEnabled: row?.remindersEnabled !== 0,
    reminderMinutes: row?.reminderMinutes ?? 5,
    completionEnabled: row?.completionEnabled !== 0,
  };
  for (const [target, publishAt] of Object.entries(schedule) as Array<[VideoTarget, Date | undefined]>) {
    if (publishAt)
      scheduleReminder(backendDb, {
        adminId: actorId,
        ref: `video:${videoDraftId}`,
        kind: `video.${target}`,
        publishAt,
        title: label || `Video #${videoDraftId}`,
        targets: [target],
        preference,
      });
  }
}

function requireOwnedVideo(backendDb: BackendDb, actorId: number, videoDraftId: number) {
  const draft = getVideoDraft(backendDb, videoDraftId);
  if (draft.adminId !== actorId) throw new StudioError("err.video-not-yours");
  return draft;
}
