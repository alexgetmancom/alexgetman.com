import { isStoryTarget, TARGET_GROUPS, targetInGroup } from "../../botTargets.js";
import type { BackendConfig } from "../../foundation/config.js";
import { instagramConfigForLocale } from "../../foundation/external/instagram.js";
import { log } from "../../foundation/logger.js";
import { createSerialQueue } from "../../foundation/serial-queue.js";
import { isCapabilityReady } from "../../observability/capabilities.js";
import type { PublishResult } from "../../publishing/errors.js";
import { platformProfile } from "../../publishing/platform-profiles.js";
import type { ClaimedPublishJob } from "../../publishing/queue.js";
import { prepareMediaItems } from "../media-prepare.js";
import { type DeliveryPort, type DeliveryPorts, deliveryAdapter } from "../ports.js";
import { publishInstagramStory, verifyInstagramPublication } from "../social/instagram.js";
import { payloadMedia } from "../social/payload.js";
import { publishToTelegram } from "../social/telegram.js";
import { publishToThreads, verifyThreadsPost } from "../social/threads.js";
import { publishToX } from "../social/x.js";
import { generateStoryMedia } from "../story-media.js";

type PreparedMedia = Awaited<ReturnType<typeof prepareMediaItems>>;

export function createPlatformPorts(config: BackendConfig, fetchImpl: typeof fetch = fetch): DeliveryPorts {
  // Publisher instances own their preparation state. This prevents cache entries
  // from leaking between test runs or independently configured worker instances.
  const mediaCache = new Map<string, Promise<PreparedMedia>>();
  // VM-106 accepts one ffmpeg job at a time.  Rendering had previously been
  // started before the ordinary media-preparation queue, so three Story
  // targets for one post could open concurrent streamed requests through the
  // SSH tunnel.  Keep that resource explicit and share the finished render
  // between Telegram and Instagram targets of the same locale.
  const storyMediaCache = new Map<string, Promise<ReturnType<typeof payloadMedia>>>();
  const enqueueMediaPreparation = createSerialQueue();
  const enqueueStoryPreparation = createSerialQueue();
  const prepare = (job: ClaimedPublishJob, publisherConfig: BackendConfig) =>
    withPreparedMedia(job, publisherConfig, fetchImpl, mediaCache, enqueueMediaPreparation, (job, media) => {
      const key = storyMediaCacheKey(job, media);
      let rendered = storyMediaCache.get(key);
      if (!rendered) {
        rendered = enqueueStoryPreparation(() => createStoryMedia(job, media, publisherConfig));
        storyMediaCache.set(key, rendered);
      }
      return rendered.catch((error) => {
        storyMediaCache.delete(key);
        throw error;
      });
    });
  const threadsEnConfig = platformConfig("threads_en", config);
  const instagramEnConfig = platformConfig("instagram_stories", config);
  const instagramRuConfig = platformConfig("instagram_stories_ru", config);
  const targetConfigs: Record<string, BackendConfig> = {
    telegram: config,
    ...Object.fromEntries(TARGET_GROUPS.threads.map((target) => [target, target === "threads_en" ? threadsEnConfig : config])),
    ...Object.fromEntries(TARGET_GROUPS.x.map((target) => [target, config])),
    ...Object.fromEntries(
      TARGET_GROUPS.instagramStory.map((target) => [
        target,
        target === "instagram_stories" ? instagramEnConfig : target === "instagram_stories_ru" ? instagramRuConfig : config,
      ]),
    ),
    ...Object.fromEntries(TARGET_GROUPS.telegramStory.map((target) => [target, config])),
  };
  const publishers: Record<string, DeliveryPort> = {
    // Every target that can use media goes through the same preparation step.
    telegram: (job) => publishToTelegram(job.payload, config, fetchImpl),
  };
  for (const target of TARGET_GROUPS.threads)
    publishers[target] = (job) =>
      publishToThreads(
        job.payload,
        target === "threads_en" ? threadsEnConfig : config,
        fetchImpl,
        target === "threads_en" ? target : undefined,
      );
  for (const target of TARGET_GROUPS.x) publishers[target] = (job) => publishToX(job.payload, config, fetchImpl);
  for (const target of TARGET_GROUPS.instagramStory)
    publishers[target] = (job) => publishInstagramStory(job.payload, targetConfigs[target] ?? config, fetchImpl);
  for (const target of TARGET_GROUPS.telegramStory)
    publishers[target] = (job) =>
      import("../social/telegramStories.js").then(({ publishTelegramStory }) => publishTelegramStory(job.payload, config));
  return Object.fromEntries(
    Object.entries(publishers).map(([target, publish]) => [
      target,
      deliveryAdapter(publish, {
        validate: async () => validatePlatformTarget(target, config),
        prepare: async (job) => (target === "telegram" ? job : prepare(job, targetConfigs[target] ?? config)),
        verify: async (_job, result) => verifyPlatformPublication(target, result, targetConfigs[target] ?? config, fetchImpl),
      }),
    ]),
  ) as DeliveryPorts;
}

export function platformConfig(target: string, config: BackendConfig): BackendConfig {
  if (target === "threads_en") return { ...config, THREADS_ACCESS_TOKEN: config.THREADS_EN_ACCESS_TOKEN ?? config.THREADS_ACCESS_TOKEN };
  // Stories carry the shared fallback for English; Reels deliberately do not.
  if (target === "instagram_stories") return instagramConfigForLocale(config, "en", "shared");
  if (target === "instagram_stories_ru") return instagramConfigForLocale(config, "ru");
  return config;
}

export async function verifyPlatformPublication(
  target: string,
  result: PublishResult,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!result.ok || result.id == null) return result;
  const id = String(result.id);
  try {
    if (targetInGroup(TARGET_GROUPS.threads, target)) {
      const verified = await verifyThreadsPost(id, config, fetchImpl);
      return { ...result, url: result.url ?? verified.url, verification: { status: "verified", providerId: verified.id } };
    }
    if (targetInGroup(TARGET_GROUPS.instagramStory, target)) {
      const verified = await verifyInstagramPublication(id, config, fetchImpl);
      return { ...result, url: result.url ?? verified.url, verification: { status: "verified", providerId: verified.id } };
    }
    return { ...result, verification: { status: "unsupported" } };
  } catch (error) {
    // The provider already returned an external ID. Verification is an
    // observation layer and must never replay the public mutation.
    return {
      ...result,
      verification: { status: "unavailable", error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** Fail before a provider request when the declarative target profile is not ready. */
function validatePlatformTarget(target: string, config: BackendConfig): void {
  const profile = platformProfile(target);
  if (!profile?.requirements.length) return;
  if (isCapabilityReady(config, profile.id)) return;
  const missing = profile.requirements.filter((name) => !(config as unknown as Record<string, unknown>)[name]);
  throw new Error(`${profile.label} is not configured: ${missing.join(", ")}`);
}

async function withPreparedMedia(
  job: ClaimedPublishJob,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  mediaCache: Map<string, Promise<PreparedMedia>>,
  enqueue: <T>(prepare: () => Promise<T>) => Promise<T>,
  renderStory: (job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>) => Promise<ReturnType<typeof payloadMedia>>,
): Promise<ClaimedPublishJob> {
  if (Array.isArray(job.payload._reconcile_ids)) return job;
  const media = payloadMedia(job.payload);
  if (media.length === 0) return job;
  // A Story is one vertical visual. Select the locale's first item before any
  // transformation: remaining album images belong only to feed targets and
  // must not consume Story-processing capacity. The Studio source is already
  // a local durable asset, so do not send it through ordinary feed staging
  // before Story rendering; that redundant step can otherwise stall a Story
  // before it ever reaches the Media Processing Port.
  const storySource = isStoryTarget(job.target) ? media.slice(0, 1) : media;
  if (isStoryTarget(job.target)) log("info", "story delivery preparation started", { jobId: job.jobId, target: job.target });
  const sourceMedia = isStoryTarget(job.target) ? await renderStory(job, storySource) : media;
  const key = mediaCacheKey(job, sourceMedia, config);
  // One preparation per (post, target, media) within a delivery cycle. The
  // rendered files persist on disk and are aged out by pruneMediaCache, so
  // there is no per-user refcount: nothing here owns eager deletion.
  let prepared = mediaCache.get(key);
  if (!prepared) {
    prepared = enqueue(() => prepareMediaItems(config, sourceMedia, fetchImpl, job.target));
    mediaCache.set(key, prepared);
  }
  let items: PreparedMedia;
  try {
    items = await prepared;
  } catch (error) {
    mediaCache.delete(key);
    throw error;
  }
  return { ...job, payload: { ...job.payload, media: items, media_en: items } };
}

async function createStoryMedia(job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>, config: BackendConfig) {
  const [source] = media;
  if (!source) return media;
  // A prior attempt may already have rendered a valid Story asset. Reusing it
  // is both idempotent and essential for recovery: retrying must not depend on
  // re-downloading or re-transcoding an unchanged source video.
  if (source.storyLocalPath) return [source];
  const locale = job.payload.locale === "ru" ? "ru" : "en";
  const draftId = Number(job.payload.draft_id ?? job.postId ?? job.jobId);
  return generateStoryMedia([source], Number.isSafeInteger(draftId) ? draftId : job.jobId, locale, config);
}

function mediaCacheKey(job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>, config: BackendConfig): string {
  return JSON.stringify({
    post: job.postKey,
    target: job.target,
    locale: job.payload.locale ?? "en",
    // Story media is a separately rendered 9:16 asset. It must never share
    // a preparation entry with the source image used by feed targets.
    story: isStoryTarget(job.target),
    media: media.map((item) => [item.fileId, item.localPath, item.type]),
    remote: config.REMOTE_MEDIA_PATH,
  });
}

function storyMediaCacheKey(job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>): string {
  return JSON.stringify({
    draft: job.payload.draft_id ?? job.postId,
    locale: job.payload.locale ?? "en",
    media: media.map((item) => [item.fileId, item.localPath, item.type]),
  });
}
