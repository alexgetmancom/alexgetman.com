import { bootstrapConfiguredChannels } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { canSync } from "../snapshots/creator-store.js";
import { syncCommunityProfiles, syncInstagramProfile, syncXProfile, syncYouTubeProfile, syncZernioChannelProfile } from "./profile-sync.js";
import { runVideoMetricSchedule } from "./video-metrics.js";

/** One step of the cycle. A provider that is permanently broken (an expired
 * YouTube token, say) must not take the rest of the cycle down with it: the loop
 * runner catches per tick, so an unguarded throw here meant video metrics were
 * never collected again until someone noticed. */
async function step(name: string, run: () => Promise<void>): Promise<number> {
  try {
    await run();
    return 1;
  } catch (error) {
    log("error", "analytics cycle step failed", { step: name, error: String(error) });
    return 0;
  }
}

/** Runs the transport-neutral analytics collection cycle. */
export async function runAnalyticsCycle(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!config.studio.modules.analytics) return 0;
  const profileInterval = config.CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS;
  let profiles = 0;
  const channels = bootstrapConfiguredChannels(backendDb, config);
  for (const channel of channels) {
    if (!canSync(backendDb, channel.id, profileInterval)) continue;
    if (channel.platform === "youtube") profiles += await step(channel.id, () => syncYouTubeProfile(config, backendDb, fetchImpl, channel));
    if (channel.platform === "instagram")
      profiles += await step(channel.id, () => syncInstagramProfile(config, backendDb, fetchImpl, channel));
    if (!["youtube", "instagram"].includes(channel.platform) && channel.provider === "zernio")
      profiles += await step(channel.id, () => syncZernioChannelProfile(config, backendDb, fetchImpl, channel));
  }
  if (
    config.ENABLE_X_PROFILE_METRICS &&
    config.X_CONSUMER_KEY &&
    config.X_CONSUMER_SECRET &&
    config.X_ACCESS_TOKEN &&
    config.X_ACCESS_TOKEN_SECRET &&
    canSync(backendDb, "x_profile", profileInterval)
  )
    profiles += await step("x_profile", () => syncXProfile(config, backendDb, fetchImpl));
  const community = [
    ...(config.controllerBotToken ? ["telegram_profile"] : []),
    ...(config.THREADS_ACCESS_TOKEN ? ["threads_profile"] : []),
  ];
  if (community.some((source) => canSync(backendDb, source, profileInterval)))
    profiles += await step("community", () => syncCommunityProfiles(config, backendDb, fetchImpl));
  let metrics = 0;
  if (config.studio.modules.video_posting)
    await step("video_metrics", async () => {
      metrics = await runVideoMetricSchedule(config, backendDb, fetchImpl);
    });
  // A successful collection is worker telemetry, not a creator notification.
  // Keeping it out of the domain event journal prevents every metrics cycle
  // from becoming an unread Inbox item in every Studio interface.
  return profiles + metrics;
}
