import type { PublicationPipeline, PublicationSchedule } from "../../application/publication-pipeline.js";
import { VIDEO_TARGETS, type VideoTarget } from "../../publishing/video-types.js";
import type { postService } from "./posts.js";
import type { videoService } from "./videos.js";

type PostService = ReturnType<typeof postService>;
type VideoService = ReturnType<typeof videoService>;

export type PublicationPipelines = {
  post: PublicationPipeline<
    ReturnType<PostService["get"]>,
    ReturnType<PostService["preview"]>,
    ReturnType<PostService["validate"]>,
    ReturnType<PostService["schedule"]>,
    ReturnType<PostService["publish"]>,
    ReturnType<PostService["cancel"]>,
    ReturnType<PostService["retryFailed"]>
  >;
  video: PublicationPipeline<
    ReturnType<VideoService["get"]>,
    ReturnType<VideoService["preview"]>,
    Awaited<ReturnType<VideoService["validate"]>>,
    Awaited<ReturnType<VideoService["schedule"]>>,
    Awaited<ReturnType<VideoService["publish"]>>,
    Awaited<ReturnType<VideoService["cancel"]>>,
    ReturnType<VideoService["retry"]>,
    VideoTarget,
    { cancelled: boolean },
    void
  >;
};

/** Adapts the two durable publication models to the shared application port. */
export function publicationPipelines(posts: PostService, videos: VideoService): PublicationPipelines {
  return { post: postPipeline(posts), video: videoPipeline(videos) };
}

function postPipeline(posts: PostService): PublicationPipelines["post"] {
  return {
    kind: "post",
    capabilities: { hasMetadataWizard: false, hasStoryCards: true, scheduleAxis: "locale" },
    get: (actorId, id) => posts.get(actorId, id),
    preview: (actorId, id) => posts.preview(actorId, id),
    validate: (actorId, id) => posts.validate(actorId, id),
    schedule: (actorId, id, input) => posts.schedule(actorId, id, postSchedule(input)),
    publish: (actorId, id) => posts.publish(actorId, id),
    cancel: (actorId, id) => posts.cancel(actorId, id),
    retryTarget: (actorId, id, target) => posts.retryFailed(actorId, id, target),
    removeTarget: (actorId, id, target) => posts.removeTarget(actorId, id, target),
    toggleTarget: (actorId, id, target) => posts.toggleTarget(actorId, id, target),
    slotTime: (clock) => posts.slotTime(clock),
  };
}

function videoPipeline(videos: VideoService): PublicationPipelines["video"] {
  return {
    kind: "video",
    capabilities: { hasMetadataWizard: true, hasStoryCards: false, scheduleAxis: "target" },
    get: (actorId, id) => videos.get(actorId, id),
    preview: (actorId, id) => videos.preview(actorId, id),
    validate: (actorId, id) => videos.validate(actorId, id),
    schedule: (actorId, id, input) => videos.schedule(actorId, id, videoSchedule(input)),
    publish: (actorId, id) => videos.publish(actorId, id),
    cancel: (actorId, id) => videos.cancel(actorId, id),
    retryTarget: (actorId, id, target) => videos.retry(actorId, id, target as VideoTarget),
    removeTarget: (actorId, id, target) => videos.removeTarget(actorId, id, target as VideoTarget),
    toggleTarget: (actorId, id, target) => toggleVideoTarget(videos, actorId, id, target as VideoTarget),
    slotTime: (clock) => videos.slotTime(clock),
  };
}

function postSchedule(input: PublicationSchedule) {
  const schedule: { ruAt: Date | null; enAt: Date | null; allowPast?: true; immediateLocale?: "ru" | "en" } = {
    ruAt: input.values.ru ?? null,
    enAt: input.values.en ?? null,
  };
  if (input.allowPast) schedule.allowPast = true;
  if (input.immediateKey === "ru" || input.immediateKey === "en") schedule.immediateLocale = input.immediateKey;
  return schedule;
}

function videoSchedule(input: PublicationSchedule) {
  return Object.fromEntries(Object.entries(input.values).filter(([target]) => VIDEO_TARGETS.includes(target as VideoTarget))) as Partial<
    Record<VideoTarget, Date>
  >;
}

function toggleVideoTarget(videos: VideoService, actorId: number, id: number, target: VideoTarget): void {
  const current = videos.get(actorId, id).targets.map((item) => item.target as VideoTarget);
  if (current.includes(target)) {
    videos.removeTarget(actorId, id, target);
    return;
  }
  videos.replaceTargets(actorId, id, [...current, target]);
}
