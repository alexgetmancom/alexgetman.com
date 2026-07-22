import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { isCapabilityReady } from "../../observability/capabilities.js";
import { canSync } from "../snapshots/creator-store.js";
import { syncCommunityProfiles, syncFacebookProfile, syncInstagramProfile, syncXProfile, syncYouTubeProfile } from "./profile-sync.js";
import { runVideoMetricSchedule } from "./video-metrics.js";

/** Runs the transport-neutral analytics collection cycle. */
export async function runAnalyticsCycle(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!config.studio.modules.analytics) return 0;
  const profileInterval = config.CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS;
  let profiles = 0;
  if (config.studio.modules.youtube && isCapabilityReady(config, "youtube_shorts") && canSync(backendDb, "youtube", profileInterval)) {
    await syncYouTubeProfile(config, backendDb, fetchImpl);
    profiles += 1;
  }
  if (config.studio.modules.instagram && isCapabilityReady(config, "instagram_reels") && canSync(backendDb, "instagram", profileInterval)) {
    await syncInstagramProfile(config, backendDb, fetchImpl);
    profiles += 1;
  }
  if (config.FACEBOOK_PAGE_ID && config.FACEBOOK_PAGE_ACCESS_TOKEN && canSync(backendDb, "facebook_profile_en", profileInterval)) {
    await syncFacebookProfile(config, backendDb, fetchImpl);
    profiles += 1;
  }
  if (
    config.ENABLE_X_PROFILE_METRICS &&
    config.X_CONSUMER_KEY &&
    config.X_CONSUMER_SECRET &&
    config.X_ACCESS_TOKEN &&
    config.X_ACCESS_TOKEN_SECRET &&
    canSync(backendDb, "x_profile", profileInterval)
  ) {
    await syncXProfile(config, backendDb, fetchImpl);
    profiles += 1;
  }
  const community = [
    ...(config.BLUESKY_HANDLE ? ["bluesky_profile"] : []),
    ...(config.controllerBotToken ? ["telegram_profile"] : []),
    ...(config.THREADS_ACCESS_TOKEN ? ["threads_profile"] : []),
  ];
  if (community.some((source) => canSync(backendDb, source, profileInterval))) {
    await syncCommunityProfiles(config, backendDb, fetchImpl);
    profiles += 1;
  }
  const metrics = config.studio.modules.video_posting ? await runVideoMetricSchedule(config, backendDb, fetchImpl) : 0;
  // A successful collection is worker telemetry, not a creator notification.
  // Keeping it out of the domain event journal prevents every metrics cycle
  // from becoming an unread Inbox item in every Studio interface.
  return profiles + metrics;
}
