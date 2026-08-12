import { TARGET_GROUPS, targetInGroup } from "../botTargets.js";
import type { BackendConfig } from "../foundation/config.js";
import { instagramCredentialsForLocale } from "../foundation/external/instagram.js";
import { isCapabilityReady } from "../observability/capabilities.js";
import type { PublishResult } from "../publishing/errors.js";
import { platformProfile } from "../publishing/platform-profiles.js";
import type { ClaimedPublishJob } from "../publishing/queue.js";
import { platformTargetConfigs } from "./platform-routing.js";
import type { DeliveryPorts, DeliveryPublisher } from "./ports.js";
import { publishToDiscord, verifyDiscordMessage } from "./social/discord.js";
import { publishInstagramStory, verifyInstagramPublication } from "./social/instagram.js";
import { publishToTelegram } from "./social/telegram.js";
import { publishToThreads, verifyThreadsPost } from "./social/threads.js";
import { publishToX, verifyXPost } from "./social/x.js";

type PreparePlatformJob = (job: ClaimedPublishJob, config: BackendConfig) => Promise<ClaimedPublishJob>;

/** Builds provider adapters from target routing and shared preparation policy. */
export function createPlatformAdapters(config: BackendConfig, fetchImpl: typeof fetch, prepare: PreparePlatformJob): DeliveryPorts {
  const targetConfigs = platformTargetConfigs(config);
  const publishers: Record<string, DeliveryPublisher> = {
    telegram: (job) => publishToTelegram(job.payload, config, fetchImpl),
  };
  for (const target of TARGET_GROUPS.threads)
    publishers[target] = (job) =>
      publishToThreads(
        job.payload,
        target === "threads_en" ? (targetConfigs[target] ?? config) : config,
        fetchImpl,
        target === "threads_en" ? target : undefined,
      );
  for (const target of TARGET_GROUPS.x) publishers[target] = (job) => publishToX(job.payload, config, fetchImpl);
  for (const target of TARGET_GROUPS.discord) publishers[target] = (job) => publishToDiscord(job.payload, config, fetchImpl);
  for (const target of TARGET_GROUPS.instagramStory)
    publishers[target] = (job) =>
      publishInstagramStory(
        job.payload,
        config,
        instagramCredentialsForLocale(config, target === "instagram_stories" ? "en" : "ru"),
        fetchImpl,
      );
  for (const target of TARGET_GROUPS.telegramStory)
    publishers[target] = (job) =>
      import("./social/telegramStories.js").then(({ publishTelegramStory }) => publishTelegramStory(job.payload, config));

  return Object.fromEntries(
    Object.entries(publishers).map(([target, publish]) => [
      target,
      {
        publish,
        validate: async () => validatePlatformTarget(target, targetConfigs[target] ?? config),
        prepare: async (job) => (target === "telegram" ? job : prepare(job, targetConfigs[target] ?? config)),
        verify: async (_job, result) => verifyPlatformPublication(target, result, targetConfigs[target] ?? config, fetchImpl),
      },
    ]),
  ) as DeliveryPorts;
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
      const verified = await verifyInstagramPublication(
        id,
        config,
        instagramCredentialsForLocale(config, target === "instagram_stories" ? "en" : "ru"),
        fetchImpl,
      );
      return { ...result, url: result.url ?? verified.url, verification: { status: "verified", providerId: verified.id } };
    }
    if (targetInGroup(TARGET_GROUPS.x, target)) {
      const verified = await verifyXPost(id, config, fetchImpl);
      return { ...result, verification: { status: "verified", providerId: verified.id } };
    }
    if (targetInGroup(TARGET_GROUPS.discord, target)) {
      const verified = await verifyDiscordMessage(id, config, fetchImpl);
      return { ...result, url: result.url ?? verified.url, verification: { status: "verified", providerId: verified.id } };
    }
    return { ...result, verification: { status: "unsupported" } };
  } catch (error) {
    return {
      ...result,
      verification: { status: "unavailable", error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function validatePlatformTarget(target: string, config: BackendConfig): void {
  if (targetInGroup(TARGET_GROUPS.instagramStory, target)) {
    const credentials = instagramCredentialsForLocale(config, target === "instagram_stories" ? "en" : "ru");
    const missing = [credentials.accessToken ? null : "Instagram access token", credentials.userId ? null : "Instagram user id"].filter(
      (name): name is string => name !== null,
    );
    if (missing.length) throw new Error(`Instagram Stories is not configured: ${missing.join(", ")}`);
    return;
  }
  const profile = platformProfile(target);
  if (!profile?.requirements.length) return;
  if (isCapabilityReady(config, profile.id)) return;
  const missing = profile.requirements.filter((name) => !(config as unknown as Record<string, unknown>)[name]);
  throw new Error(`${profile.label} is not configured: ${missing.join(", ")}`);
}
