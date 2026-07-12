import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { prepareMediaItems } from "../media/prepare.js";
import { generateStoryMedia } from "../media/story.js";
import type { PublishResult } from "../queue/errors.js";
import type { ClaimedPublishJob } from "../queue/publish.js";
import { publishToBluesky } from "./bluesky.js";
import { devtoArticleFromPayload, publishToDevto } from "./devto.js";
import { publishToFacebook } from "./facebook.js";
import { publishToGitHubDiscussion } from "./github.js";
import { publishInstagramStory } from "./instagram.js";
import { publishToLinkedIn } from "./linkedin.js";
import { publishToMastodon } from "./mastodon.js";
import { payloadMedia } from "./payload.js";
import { publishToTelegram } from "./telegram.js";
import { publishToThreads } from "./threads.js";
import { publishToX } from "./x.js";

export type Publisher = (job: ClaimedPublishJob) => Promise<PublishResult>;

type PreparedMedia = Awaited<ReturnType<typeof prepareMediaItems>>;
type MediaCacheEntry = {
  prepared: Promise<PreparedMedia>;
  users: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

const mediaCache = new Map<string, MediaCacheEntry>();
let mediaPreparationTail: Promise<void> = Promise.resolve();

export function createPublishers(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Record<string, Publisher> {
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
  return {
    devto: (job) => publishToDevto(devtoArticleFromPayload(job.payload, config), config, fetchImpl),
    telegram: (job) => publishToTelegram(job.payload, config, fetchImpl),
    mastodon: (job) => publishToMastodon(job.payload, config, fetchImpl),
    bluesky: (job) => publishToBluesky(job.payload, config, fetchImpl),
    github: (job) => publishToGitHubDiscussion(job.payload, config, fetchImpl),
    github_discussions: (job) => publishToGitHubDiscussion(job.payload, config, fetchImpl),
    github_en: (job) => publishToGitHubDiscussion(job.payload, config, fetchImpl),
    github_ru: (job) => publishToGitHubDiscussion(job.payload, config, fetchImpl),
    threads: (job) => withPreparedMedia(job, config, fetchImpl, (payload) => publishToThreads(payload, config, fetchImpl)),
    threads_ru: (job) => withPreparedMedia(job, config, fetchImpl, (payload) => publishToThreads(payload, config, fetchImpl)),
    threads_en: (job) =>
      withPreparedMedia(job, threadsEnConfig, fetchImpl, (payload) => publishToThreads(payload, threadsEnConfig, fetchImpl)),
    facebook: (job) => withPreparedMedia(job, config, fetchImpl, (payload) => publishToFacebook(payload, config, fetchImpl)),
    facebook_ru: (job) =>
      withPreparedMedia(job, facebookRuConfig, fetchImpl, (payload) => publishToFacebook(payload, facebookRuConfig, fetchImpl)),
    linkedin: (job) => withPreparedMedia(job, config, fetchImpl, (payload) => publishToLinkedIn(payload, config, fetchImpl)),
    x: (job) => withPreparedMedia(job, config, fetchImpl, (payload) => publishToX(payload, config, fetchImpl)),
    twitter: (job) => withPreparedMedia(job, config, fetchImpl, (payload) => publishToX(payload, config, fetchImpl)),
    instagram_story: (job) => withPreparedMedia(job, config, fetchImpl, (payload) => publishInstagramStory(payload, config, fetchImpl)),
    instagram_stories: (job) =>
      withPreparedMedia(job, instagramEnConfig, fetchImpl, (payload) => publishInstagramStory(payload, instagramEnConfig, fetchImpl)),
    instagram_stories_ru: (job) =>
      withPreparedMedia(job, instagramRuConfig, fetchImpl, (payload) => publishInstagramStory(payload, instagramRuConfig, fetchImpl)),
    telegram_story: (job) =>
      withPreparedMedia(job, config, fetchImpl, async (payload) =>
        (await import("./telegramStories.js")).publishTelegramStory(payload, config, backendDb, fetchImpl),
      ),
    telegram_stories: (job) =>
      withPreparedMedia(job, config, fetchImpl, async (payload) =>
        (await import("./telegramStories.js")).publishTelegramStory(payload, config, backendDb, fetchImpl),
      ),
  };
}

async function withPreparedMedia(
  job: ClaimedPublishJob,
  config: BackendConfig,
  fetchImpl: typeof fetch,
  publish: (payload: Record<string, unknown>) => Promise<PublishResult>,
): Promise<PublishResult> {
  const media = payloadMedia(job.payload);
  if (media.length === 0) return publish(job.payload);
  const sourceMedia = isStoryTarget(job.target) ? await createStoryMedia(job, media, config) : media;
  const key = mediaCacheKey(job, sourceMedia, config);
  let entry = mediaCache.get(key);
  if (!entry) {
    entry = { prepared: enqueueMediaPreparation(() => prepareMediaItems(config, sourceMedia, fetchImpl)), users: 0, cleanupTimer: null };
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
    locale: job.payload.locale ?? "en",
    media: media.map((item) => [item.fileId, item.localPath, item.type]),
    remote: config.REMOTE_MEDIA_PATH,
  });
}

function enqueueMediaPreparation<T>(prepare: () => Promise<T>): Promise<T> {
  const next = mediaPreparationTail.then(prepare, prepare);
  mediaPreparationTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
