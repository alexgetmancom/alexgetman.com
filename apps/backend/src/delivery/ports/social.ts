import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { PublishResult } from "../../publishing/errors.js";
import type { ClaimedPublishJob } from "../../publishing/queue.js";
import { prepareMediaItems } from "../media-prepare.js";
import { type DeliveryPort, type DeliveryPorts, deliveryAdapter } from "../ports.js";
import { publishToBluesky } from "../social/bluesky.js";
import { devtoArticleFromPayload, publishToDevto } from "../social/devto.js";
import { publishToFacebook } from "../social/facebook.js";
import { publishToGitHubDiscussion } from "../social/github.js";
import { publishInstagramStory } from "../social/instagram.js";
import { publishToLinkedIn } from "../social/linkedin.js";
import { publishToMastodon } from "../social/mastodon.js";
import { payloadMedia } from "../social/payload.js";
import { publishToTelegram } from "../social/telegram.js";
import { publishToThreads } from "../social/threads.js";
import { publishToX } from "../social/x.js";
import { generateStoryMedia } from "../story-media.js";

type PreparedMedia = Awaited<ReturnType<typeof prepareMediaItems>>;
type MediaCacheEntry = {
  prepared: Promise<PreparedMedia>;
  users: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

export function createPlatformPorts(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): DeliveryPorts {
  // Publisher instances own their preparation state. This prevents cache entries
  // from leaking between test runs or independently configured worker instances.
  const mediaCache = new Map<string, MediaCacheEntry>();
  let mediaPreparationTail: Promise<void> = Promise.resolve();
  const prepare = (
    job: ClaimedPublishJob,
    publisherConfig: BackendConfig,
    publish: (payload: Record<string, unknown>) => Promise<PublishResult>,
  ) =>
    withPreparedMedia(job, publisherConfig, fetchImpl, publish, mediaCache, (work) => {
      const next = mediaPreparationTail.then(work, work);
      mediaPreparationTail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    });
  const threadsEnConfig = { ...config, THREADS_ACCESS_TOKEN: config.THREADS_EN_ACCESS_TOKEN ?? config.THREADS_ACCESS_TOKEN };
  const facebookRuConfig = {
    ...config,
    FACEBOOK_PAGE_ACCESS_TOKEN: config.FACEBOOK_RU_PAGE_ACCESS_TOKEN ?? config.FACEBOOK_PAGE_ACCESS_TOKEN,
    FACEBOOK_PAGE_ID: config.FACEBOOK_RU_PAGE_ID ?? config.FACEBOOK_PAGE_ID,
  };
  const instagramEnConfig = {
    ...config,
    INSTAGRAM_ACCESS_TOKEN: config.INSTAGRAM_EN_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN,
    INSTAGRAM_USER_ID: config.INSTAGRAM_EN_USER_ID ?? config.INSTAGRAM_USER_ID,
  };
  const instagramRuConfig = {
    ...config,
    INSTAGRAM_ACCESS_TOKEN: config.INSTAGRAM_RU_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN,
    INSTAGRAM_USER_ID: config.INSTAGRAM_RU_USER_ID ?? config.INSTAGRAM_USER_ID,
  };
  const publishers: Record<string, DeliveryPort> = {
    // Every target that can use media goes through the same preparation step.
    // It supplies both local files (Bluesky, Mastodon) and public URLs (Dev.to, GitHub).
    devto: (job) => prepare(job, config, (payload) => publishToDevto(devtoArticleFromPayload(payload, config), config, fetchImpl)),
    telegram: (job) => publishToTelegram(job.payload, config, fetchImpl),
    mastodon: (job) => prepare(job, config, (payload) => publishToMastodon(payload, config, fetchImpl)),
    bluesky: (job) => prepare(job, config, (payload) => publishToBluesky(payload, config, fetchImpl)),
    github: (job) => prepare(job, config, (payload) => publishToGitHubDiscussion(payload, config, fetchImpl)),
    github_discussions: (job) => prepare(job, config, (payload) => publishToGitHubDiscussion(payload, config, fetchImpl)),
    github_en: (job) => prepare(job, config, (payload) => publishToGitHubDiscussion(payload, config, fetchImpl)),
    github_ru: (job) => prepare(job, config, (payload) => publishToGitHubDiscussion(payload, config, fetchImpl)),
    threads: (job) => prepare(job, config, (payload) => publishToThreads(payload, config, fetchImpl)),
    threads_ru: (job) => prepare(job, config, (payload) => publishToThreads(payload, config, fetchImpl)),
    threads_en: (job) => prepare(job, threadsEnConfig, (payload) => publishToThreads(payload, threadsEnConfig, fetchImpl)),
    facebook: (job) => prepare(job, config, (payload) => publishToFacebook(payload, config, fetchImpl)),
    facebook_ru: (job) => prepare(job, facebookRuConfig, (payload) => publishToFacebook(payload, facebookRuConfig, fetchImpl)),
    linkedin: (job) => prepare(job, config, (payload) => publishToLinkedIn(payload, config, fetchImpl)),
    x: (job) => prepare(job, config, (payload) => publishToX(payload, config, fetchImpl)),
    twitter: (job) => prepare(job, config, (payload) => publishToX(payload, config, fetchImpl)),
    instagram_story: (job) => prepare(job, config, (payload) => publishInstagramStory(payload, config, fetchImpl)),
    instagram_stories: (job) => prepare(job, instagramEnConfig, (payload) => publishInstagramStory(payload, instagramEnConfig, fetchImpl)),
    instagram_stories_ru: (job) =>
      prepare(job, instagramRuConfig, (payload) => publishInstagramStory(payload, instagramRuConfig, fetchImpl)),
    telegram_story: (job) =>
      prepare(job, config, async (payload) =>
        (await import("../social/telegramStories.js")).publishTelegramStory(payload, config, backendDb, fetchImpl),
      ),
    telegram_stories: (job) =>
      prepare(job, config, async (payload) =>
        (await import("../social/telegramStories.js")).publishTelegramStory(payload, config, backendDb, fetchImpl),
      ),
  };
  return Object.fromEntries(Object.entries(publishers).map(([target, publish]) => [target, deliveryAdapter(publish)])) as DeliveryPorts;
}

async function withPreparedMedia(
  job: ClaimedPublishJob,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  publish: (payload: Record<string, unknown>) => Promise<PublishResult>,
  mediaCache: Map<string, MediaCacheEntry>,
  enqueue: <T>(prepare: () => Promise<T>) => Promise<T>,
): Promise<PublishResult> {
  if (Array.isArray(job.payload._reconcile_ids)) return publish(job.payload);
  const media = payloadMedia(job.payload);
  if (media.length === 0) return publish(job.payload);
  const sourceMedia = isStoryTarget(job.target) ? await createStoryMedia(job, media, config) : media;
  const key = mediaCacheKey(job, sourceMedia, config);
  let entry = mediaCache.get(key);
  if (!entry) {
    entry = { prepared: enqueue(() => prepareMediaItems(config, sourceMedia, fetchImpl, job.target)), users: 0, cleanupTimer: null };
    mediaCache.set(key, entry);
  }
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
  entry.users += 1;
  let prepared: PreparedMedia;
  try {
    prepared = await entry.prepared;
  } catch (error) {
    entry.users -= 1;
    if (entry.users === 0) mediaCache.delete(key);
    throw error;
  }
  try {
    return await publish({ ...job.payload, media: prepared.items, media_en: prepared.items });
  } finally {
    entry.users -= 1;
    if (entry.users === 0) {
      entry.cleanupTimer = setTimeout(() => {
        void prepared.cleanup().finally(() => mediaCache.delete(key));
      }, config.MEDIA_CACHE_TTL_SECONDS * 1000);
    }
  }
}

function isStoryTarget(target: string): boolean {
  return (
    target === "telegram_story" || target === "telegram_stories" || target === "instagram_story" || target.startsWith("instagram_stories")
  );
}

async function createStoryMedia(job: ClaimedPublishJob, media: ReturnType<typeof payloadMedia>, config: BackendConfig) {
  const [source] = media;
  if (!source) return media;
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
