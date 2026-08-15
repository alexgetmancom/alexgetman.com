import { TARGET_GROUPS, targetInGroup } from "../botTargets.js";
import type { BackendConfig } from "../foundation/config.js";
import { instagramCredentialsForLocale } from "../foundation/external/instagram.js";
import { type ThreadsTarget, threadsCredentials } from "../foundation/external/threads.js";
import { requestJson } from "../foundation/http.js";
import { isCapabilityReady } from "../observability/capabilities.js";
import type { PublishResult } from "../publishing/errors.js";
import { platformProfile } from "../publishing/platform-profiles.js";
import type { ClaimedPublishJob } from "../publishing/queue.js";
import type { DeliveryAdapter, DeliveryPorts, DeliveryPublisher } from "./ports.js";
import { deleteDiscordMessage, editDiscordMessage, publishToDiscord, verifyDiscordMessage } from "./social/discord.js";
import { publishInstagramStory, verifyInstagramPublication } from "./social/instagram.js";
import { publishToTelegram } from "./social/telegram.js";
import { publishToThreads, verifyThreadsPost } from "./social/threads.js";
import { publishToX, verifyXPost } from "./social/x.js";
import { zernioPublisher } from "./zernio.js";

type PreparePlatformJob = (job: ClaimedPublishJob, config: BackendConfig) => Promise<ClaimedPublishJob>;

/** How each connected target is delivered. A target absent from here is
 * delivered natively, which is what every one of them did before a provider
 * could carry anything but video. */
export type TargetRouting = Record<string, { provider: string; accountId: string | null }>;

/** Builds provider adapters from target routing and shared preparation policy. */
export function createPlatformAdapters(
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
  prepare: PreparePlatformJob = async (job) => job,
  routing: TargetRouting = {},
): DeliveryPorts {
  const throughProvider = (target: string) => routing[target]?.provider === "zernio";
  const accountFor = (target: string) => routing[target]?.accountId ?? null;
  const publishers: Record<string, DeliveryPublisher> = {
    telegram: (job) => publishToTelegram(job.payload, config, fetchImpl),
  };
  for (const target of TARGET_GROUPS.threads)
    publishers[target] = throughProvider(target)
      ? zernioPublisher(config, fetchImpl, target, "threads", accountFor(target))
      : (job) => publishToThreads(job.payload, config, fetchImpl, target);
  for (const target of TARGET_GROUPS.x) publishers[target] = (job) => publishToX(job.payload, config, fetchImpl);
  for (const target of TARGET_GROUPS.discord) publishers[target] = (job) => publishToDiscord(job.payload, config, fetchImpl);
  for (const target of TARGET_GROUPS.instagramStory)
    publishers[target] = throughProvider(target)
      ? zernioPublisher(config, fetchImpl, target, "instagram", accountFor(target), "story")
      : (job) =>
          publishInstagramStory(
            job.payload,
            config,
            instagramCredentialsForLocale(config, target === "instagram_stories" ? "en" : "ru"),
            fetchImpl,
          );
  for (const target of TARGET_GROUPS.telegramStory)
    publishers[target] = (job) =>
      import("./social/telegramStories.js").then(({ publishTelegramStory }) => publishTelegramStory(job.payload, config));

  const mutations = platformMutations(config, fetchImpl);
  return Object.fromEntries(
    Object.entries(publishers).map(([target, publish]) => {
      const adapter: DeliveryAdapter = {
        publish,
        validate: async () => validatePlatformTarget(target, config, throughProvider(target)),
        prepare: async (job) => (target === "telegram" ? job : prepare(job, config)),
        verify: async (_job, result) => verifyPlatformPublication(target, result, config, fetchImpl),
        ...mutations[target],
      };
      return [target, adapter];
    }),
  ) as DeliveryPorts;
}

function platformMutations(config: BackendConfig, fetchImpl: typeof fetch): Partial<Record<string, Partial<DeliveryAdapter>>> {
  const telegramToken = config.controllerBotToken;
  const telegram: Partial<DeliveryAdapter> = {
    edit: async ({ externalId, text, chatId, mediaCount }) => {
      if (!telegramToken) return { ok: false, skipped: true, error: "missing CONTROLLER_BOT_TOKEN" };
      const method = mediaCount > 0 ? "editMessageCaption" : "editMessageText";
      const field = mediaCount > 0 ? "caption" : "text";
      const response = await requestJson<Record<string, unknown>>(
        fetchImpl,
        `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${telegramToken}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId || config.TELEGRAM_CHANNEL_USERNAME, message_id: Number(externalId), [field]: text }),
        },
      );
      return { ok: response.ok !== false, response };
    },
    remove: (id) => {
      if (!telegramToken) throw new Error("missing CONTROLLER_BOT_TOKEN");
      return requestJson(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${telegramToken}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.TELEGRAM_CHANNEL_USERNAME, message_id: Number(id) }),
      });
    },
  };
  const discord: Partial<DeliveryAdapter> = {
    edit: async ({ externalId, text, externalIdCount }) => {
      if (externalIdCount > 1) return { ok: false, skipped: true, error: "discord_post_is_split" };
      const limit = platformProfile("discord")?.limits?.text ?? 2000;
      if (text.length > limit) return { ok: false, skipped: true, error: "edit_exceeds_discord_limit" };
      return { ok: true, response: await editDiscordMessage(externalId, text, config, fetchImpl) };
    },
    remove: (id) => deleteDiscordMessage(id, config, fetchImpl),
  };
  return {
    telegram,
    ...Object.fromEntries(TARGET_GROUPS.discord.map((target) => [target, discord])),
    ...Object.fromEntries(
      TARGET_GROUPS.threads.map((target) => {
        const credentials = threadsCredentials(config, target as ThreadsTarget);
        return [
          target,
          {
            remove: (id: string) => {
              if (!credentials.accessToken) throw new Error(`missing ${credentials.envName}`);
              return requestJson(
                fetchImpl,
                `https://graph.threads.net/v1.0/${encodeURIComponent(id)}?access_token=${encodeURIComponent(credentials.accessToken)}`,
                { method: "DELETE" },
              );
            },
          },
        ];
      }),
    ),
  };
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
      const verified = await verifyThreadsPost(id, config, fetchImpl, target as "threads_ru" | "threads_en");
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

function validatePlatformTarget(target: string, config: BackendConfig, throughProvider: boolean): void {
  // What a target needs is what its delivery path reads. A story routed through
  // the provider was still asked for the Instagram tokens it never touches, so
  // a Studio that only ever had the provider key could not publish one.
  if (throughProvider) {
    if (!config.ZERNIO_API_KEY) throw new Error("Delivery through the provider is not configured: ZERNIO_API_KEY");
    return;
  }
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
