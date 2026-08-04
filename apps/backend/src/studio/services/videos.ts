import type { Issue, PublicationPipeline, PublicationSchedule } from "../../application/publication-pipeline.js";
import { publicationRef } from "../../application/publication-ref.js";
import { requireStudioMediaAssets } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import { keepYouTubeUploadPrivate } from "../../delivery/video-publishers.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { parseManualSchedule, publicationSlotTime } from "../../publishing/schedule.js";
import { isVideoTargetMetadataEditable } from "../../publishing/state.js";
import {
  cancelVideo,
  createVideoDraft,
  removeVideoTarget,
  replaceVideoTargets,
  retryVideoTarget,
  saveVideoMetadata,
  scheduleVideo,
  updateVideoLabel,
  validateVideoDraft,
} from "../../publishing/video-service.js";
import type { VideoLocale, VideoMetadata, VideoTarget } from "../../publishing/video-types.js";
import { accessibleStudioActorIds } from "../access.js";
import { videoDeliveryProjections } from "../projections.js";
import { requireOwnedPublication } from "./publication-access.js";
import { settingsService } from "./settings.js";

/** Video publication command boundary for Telegram Studio, Web Studio and MCP. */
export function videoService(backendDb: BackendDb, config: BackendConfig) {
  const service = {
    kind: "video" as const,
    capabilities: { hasMetadataWizard: true, hasStoryCards: false, scheduleAxis: "target" as const },
    create(actorId: number, studioMediaAssetId: number, locale: VideoLocale = "ru"): number {
      const [asset] = requireStudioMediaAssets(backendDb, actorId, [studioMediaAssetId], accessibleStudioActorIds(config, actorId));
      if (asset?.kind !== "video") throw new StudioError("err.video-needs-asset");
      return createVideoDraft(backendDb, actorId, { studioMediaAssetId }, config.VIDEO_MEDIA_RETENTION_HOURS, locale);
    },
    get(actorId: number, publicationId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
      return { id: draft.id, status: draft.status, draft, targets: backendDb.studioVideos.targets(publicationId) };
    },
    metadataEditableTargets(actorId: number, publicationId: number): VideoTarget[] {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return backendDb.studioVideos
        .targets(publicationId)
        .filter((target) => isVideoTargetMetadataEditable(target.status))
        .map((target) => target.target as VideoTarget);
    },
    list(actorId: number, limit = 50) {
      return backendDb.studioVideos.list(accessibleStudioActorIds(config, actorId), limit);
    },
    async schedule(actorId: number, publicationId: number, schedule: Partial<Record<VideoTarget, Date>> | PublicationSchedule) {
      return scheduleOwnedVideo(backendDb, config, actorId, publicationId, toVideoScheduleInput(schedule));
    },
    async validate(actorId: number, publicationId: number): Promise<Issue[]> {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      await validateVideoDraft(config, backendDb, publicationId);
      return [];
    },
    async technicalCheck(actorId: number, publicationId: number) {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return validateVideoDraft(config, backendDb, publicationId);
    },
    async publish(actorId: number, publicationId: number) {
      // Access first: otherwise an outsider's draft answers "choose platforms"
      // instead of "not yours", which leaks whether it exists and how it looks.
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      const targets = backendDb.studioVideos.targets(publicationId).map((row) => row.target as VideoTarget);
      if (!targets.length) throw new StudioError("err.video-choose-platforms");
      const schedule = Object.fromEntries(targets.map((target) => [target, new Date(Date.now() + 60_000)])) as Partial<
        Record<VideoTarget, Date>
      >;
      return scheduleOwnedVideo(backendDb, config, actorId, publicationId, schedule);
    },
    retryTarget(actorId: number, publicationId: number, target: VideoTarget): void {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      retryVideoTarget(backendDb, publicationId, target);
    },
    async cancel(actorId: number, publicationId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
      const cancellation = cancelVideo(backendDb, publicationId, config.VIDEO_MEDIA_RETENTION_HOURS);
      cancelScheduledNotifications(backendDb, publicationRef("video", publicationId));
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
          ref: publicationRef("video", publicationId),
          type: "studio.notification.video_cancelled",
          severity: holdFailures.length ? "warn" : "info",
          message: cancellation.manualRemoval.length
            ? `Video #${publicationId} was cancelled locally; published targets require manual removal.`
            : `Video #${publicationId} was cancelled locally; YouTube schedule needs attention.`,
          details: {
            manual_removal: cancellation.manualRemoval,
            held_private_youtube_ids: heldPrivateYouTubeIds,
            hold_failures: holdFailures,
          },
        });
      }
      return { ...cancellation, heldPrivateYouTubeIds, holdFailures };
    },
    preview(actorId: number, publicationId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
      return {
        id: draft.id,
        status: draft.status,
        issues: [],
        draft,
        targets: backendDb.studioVideos.targets(publicationId),
        delivery: videoDeliveryProjections(backendDb, publicationId),
      };
    },
    status(actorId: number, publicationId: number) {
      const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
      return {
        draft,
        targets: backendDb.studioVideos.targets(publicationId),
        jobs: backendDb.studioVideos.jobs(publicationId),
      };
    },
    history(actorId: number, publicationId: number, limit = 50) {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return backendDb.studioVideos.history(publicationRef("video", publicationId), limit);
    },
    updateMetadata(actorId: number, publicationId: number, target: VideoTarget, metadata: VideoMetadata): void {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      saveVideoMetadata(backendDb, publicationId, target, metadata);
    },
    rename(actorId: number, publicationId: number, label: string): void {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      updateVideoLabel(backendDb, publicationId, label);
    },
    replaceTargets(actorId: number, publicationId: number, targets: VideoTarget[]): void {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      replaceVideoTargets(backendDb, publicationId, targets);
    },
    removeTarget(actorId: number, publicationId: number, target: VideoTarget): { cancelled: boolean } {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return { cancelled: removeVideoTarget(backendDb, publicationId, target, config.VIDEO_MEDIA_RETENTION_HOURS) };
    },
    toggleTarget(actorId: number, publicationId: number, target: string): void {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      const current = backendDb.studioVideos.targets(publicationId).map((item) => item.target as VideoTarget);
      const videoTarget = target as VideoTarget;
      if (current.includes(videoTarget)) {
        removeVideoTarget(backendDb, publicationId, videoTarget, config.VIDEO_MEDIA_RETENTION_HOURS);
        return;
      }
      replaceVideoTargets(backendDb, publicationId, [...current, videoTarget]);
    },
    manualSchedule(actorId: number, publicationId: number, value: string): Date {
      requireOwnedVideo(backendDb, config, actorId, publicationId);
      return parseManualSchedule(value, config.TIMEZONE, backendDb.clock.now());
    },
    /** Resolves a slot-button clock (`HH:MM` in the configured Studio zone) to its next occurrence. */
    slotTime(clock: string): Date {
      return publicationSlotTime(clock, config.TIMEZONE, backendDb.clock.now());
    },
  };
  service satisfies PublicationPipeline;
  return service;
}

function toVideoScheduleInput(input: Partial<Record<VideoTarget, Date>> | PublicationSchedule): Partial<Record<VideoTarget, Date>> {
  if (!("values" in input)) return input;
  return Object.fromEntries(
    Object.entries(input.values).filter(([target]) => ["youtube_shorts", "instagram_reels"].includes(target)),
  ) as Partial<Record<VideoTarget, Date>>;
}

/** Shared by `schedule` (explicit times) and `publish` (schedule ~now): both
 * validate the source, write the schedule and arm reminders identically. */
async function scheduleOwnedVideo(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  publicationId: number,
  schedule: Partial<Record<VideoTarget, Date>>,
) {
  const draft = requireOwnedVideo(backendDb, config, actorId, publicationId);
  const technical = await validateVideoDraft(config, backendDb, publicationId);
  scheduleVideo(
    backendDb,
    publicationId,
    schedule,
    { prepareLeadMinutes: config.VIDEO_PREPARE_LEAD_MINUTES, reminderMinutes: config.VIDEO_REMINDER_MINUTES },
    config,
    technical.seconds,
  );
  scheduleVideoReminders(backendDb, draft.actorId, publicationId, draft.label);
  return technical;
}

function scheduleVideoReminders(backendDb: BackendDb, ownerId: number, publicationId: number, label: string): void {
  cancelScheduledNotifications(backendDb, publicationRef("video", publicationId));
  const preference = settingsService(backendDb).notifications(ownerId);
  const grouped = new Map<string, VideoTarget[]>();
  for (const target of backendDb.studioVideos.targets(publicationId)) {
    if (!target.scheduledAt || ["published", "cancelled", "failed", "verification_required"].includes(target.status)) continue;
    const targets = grouped.get(target.scheduledAt) ?? [];
    targets.push(target.target as VideoTarget);
    grouped.set(target.scheduledAt, targets);
  }
  for (const [publishAt, targets] of grouped) {
    scheduleReminder(backendDb, {
      actorId: ownerId,
      ref: publicationRef("video", publicationId),
      kind: `video.${publishAt}`,
      publishAt: new Date(publishAt),
      title: label || `Video #${publicationId}`,
      targets,
      preference,
    });
  }
}

function requireOwnedVideo(backendDb: BackendDb, config: BackendConfig, actorId: number, publicationId: number) {
  return requireOwnedPublication(
    backendDb.studioVideos.get(publicationId),
    config,
    actorId,
    "Video publication was not found.",
    "err.video-not-yours",
  );
}
