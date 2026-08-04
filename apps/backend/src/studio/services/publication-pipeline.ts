import type { DraftMessage } from "../../content/index.js";
import type { VideoLocale, VideoTarget } from "../../publishing/video-types.js";
import type { StudioActorId } from "../contracts.js";
import type { PostScheduleInput } from "./post-scheduling.js";
import type { postService } from "./posts.js";
import type { videoService } from "./videos.js";

/** What an adapter has on hand when it wants to publish something: raw text/media
 * content, or a video file already imported as a studio media asset. */
export type PublicationMedia =
  | { kind: "post"; message: DraftMessage }
  | { kind: "video"; studioMediaAssetId: number; locale?: VideoLocale };

/** A reference to whichever entity the pipeline operates on. */
export type PublicationRef = { kind: "post" | "video"; id: number };

export type PublicationCapabilities = {
  hasMetadataWizard: boolean;
  hasStoryCards: boolean;
  scheduleAxis: "locale" | "target";
};

export type PublicationSchedule = { kind: "post"; input: PostScheduleInput } | { kind: "video"; input: Partial<Record<VideoTarget, Date>> };

export type PublicationPipeline = {
  capabilities(kind: PublicationRef["kind"]): PublicationCapabilities;
  create(actorId: StudioActorId, media: PublicationMedia): PublicationRef;
  get(actorId: StudioActorId, ref: PublicationRef): unknown;
  preview(actorId: StudioActorId, ref: PublicationRef): unknown;
  validate(actorId: StudioActorId, ref: PublicationRef): Promise<unknown>;
  schedule(actorId: StudioActorId, ref: PublicationRef, schedule: PublicationSchedule["input"]): Promise<unknown>;
  publish(actorId: StudioActorId, ref: PublicationRef): Promise<unknown>;
  cancel(actorId: StudioActorId, ref: PublicationRef): Promise<unknown>;
  retryTarget(actorId: StudioActorId, ref: PublicationRef, target: string): Promise<unknown>;
  removeTarget(actorId: StudioActorId, ref: PublicationRef, target: string): unknown;
  toggleTarget(actorId: StudioActorId, ref: PublicationRef, target: string): unknown;
  slotTime(ref: PublicationRef, clock: string): Date;
};

type PublicationAdapter = {
  capabilities: PublicationCapabilities;
  create(actorId: StudioActorId, media: PublicationMedia): number;
  get(actorId: StudioActorId, id: number): unknown;
  preview(actorId: StudioActorId, id: number): unknown;
  validate(actorId: StudioActorId, id: number): Promise<unknown>;
  schedule(actorId: StudioActorId, id: number, input: unknown): Promise<unknown>;
  publish(actorId: StudioActorId, id: number): Promise<unknown>;
  cancel(actorId: StudioActorId, id: number): Promise<unknown>;
  retryTarget(actorId: StudioActorId, id: number, target: string): Promise<unknown>;
  removeTarget(actorId: StudioActorId, id: number, target: string): unknown;
  toggleTarget(actorId: StudioActorId, id: number, target: string): unknown;
  slotTime(clock: string): Date;
};

/**
 * Transport-neutral publication port. Post and video are adapters of the same
 * command contract; their workflow differences are exposed as capabilities.
 */
export function publicationPipelineService(
  posts: ReturnType<typeof postService>,
  videos: ReturnType<typeof videoService>,
): PublicationPipeline {
  const adapters: Record<PublicationRef["kind"], PublicationAdapter> = {
    post: {
      capabilities: { hasMetadataWizard: false, hasStoryCards: true, scheduleAxis: "locale" },
      create: (actorId, media) => {
        if (media.kind !== "post") throw new Error("Post adapter received video media.");
        return posts.create(actorId, media.message);
      },
      get: (actorId, id) => posts.get(actorId, id),
      preview: (actorId, id) => posts.preview(actorId, id),
      validate: async (actorId, id) => posts.validate(actorId, id),
      schedule: async (actorId, id, input) => posts.schedule(actorId, id, input as PostScheduleInput),
      publish: async (actorId, id) => posts.publish(actorId, id),
      cancel: async (actorId, id) => posts.cancel(actorId, id),
      retryTarget: async (actorId, id, target) => posts.retryFailed(actorId, id, target),
      removeTarget: (actorId, id, target) => posts.removeTarget(actorId, id, target),
      toggleTarget: (actorId, id, target) => posts.toggleTarget(actorId, id, target),
      slotTime: (clock) => posts.slotTime(clock),
    },
    video: {
      capabilities: { hasMetadataWizard: true, hasStoryCards: false, scheduleAxis: "target" },
      create: (actorId, media) => {
        if (media.kind !== "video") throw new Error("Video adapter received post media.");
        return videos.create(actorId, media.studioMediaAssetId, media.locale);
      },
      get: (actorId, id) => videos.get(actorId, id),
      preview: (actorId, id) => videos.preview(actorId, id),
      validate: (actorId, id) => videos.validate(actorId, id),
      schedule: (actorId, id, input) => videos.schedule(actorId, id, input as Partial<Record<VideoTarget, Date>>),
      publish: (actorId, id) => videos.publish(actorId, id),
      cancel: (actorId, id) => videos.cancel(actorId, id),
      retryTarget: async (actorId, id, target) => videos.retry(actorId, id, target as VideoTarget),
      removeTarget: (actorId, id, target) => videos.removeTarget(actorId, id, target as VideoTarget),
      toggleTarget: (actorId, id, target) => {
        const current = videos.get(actorId, id).targets.map((row) => row.target as VideoTarget);
        const next = current.includes(target as VideoTarget)
          ? current.filter((item) => item !== target)
          : [...current, target as VideoTarget];
        return videos.replaceTargets(actorId, id, next);
      },
      slotTime: (clock) => videos.slotTime(clock),
    },
  };

  const adapterFor = (ref: PublicationRef): PublicationAdapter => adapters[ref.kind];
  return {
    capabilities: (kind) => adapters[kind].capabilities,
    create: (actorId, media) => ({ kind: media.kind, id: adapters[media.kind].create(actorId, media) }),
    get: (actorId, ref) => adapterFor(ref).get(actorId, ref.id),
    preview: (actorId, ref) => adapterFor(ref).preview(actorId, ref.id),
    validate: (actorId, ref) => adapterFor(ref).validate(actorId, ref.id),
    schedule: (actorId, ref, schedule) => adapterFor(ref).schedule(actorId, ref.id, schedule),
    publish: (actorId, ref) => adapterFor(ref).publish(actorId, ref.id),
    cancel: (actorId, ref) => adapterFor(ref).cancel(actorId, ref.id),
    retryTarget: (actorId, ref, target) => adapterFor(ref).retryTarget(actorId, ref.id, target),
    removeTarget: (actorId, ref, target) => adapterFor(ref).removeTarget(actorId, ref.id, target),
    toggleTarget: (actorId, ref, target) => adapterFor(ref).toggleTarget(actorId, ref.id, target),
    slotTime: (ref, clock) => adapterFor(ref).slotTime(clock),
  };
}
