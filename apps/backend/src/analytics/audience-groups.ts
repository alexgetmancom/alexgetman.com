import type { BackendConfig } from "../foundation/config.js";

/** Text platforms carry the written feed; video platforms carry Shorts/Reels.
 * The two audiences are counted separately everywhere — a single combined
 * total is dominated by whichever side is larger and says nothing useful about
 * either one. Keys are exactly the platforms `creator_profiles` can hold. */
export type AudienceGroup = "text" | "video";

const AUDIENCE_GROUPS: Record<string, AudienceGroup> = {
  telegram: "text",
  threads: "text",
  x: "text",
  instagram: "video",
  youtube: "video",
};

export function audienceGroup(platform: string): AudienceGroup | null {
  return (
    AUDIENCE_GROUPS[platform] ??
    (platform.startsWith("threads_") ? "text" : null) ??
    (platform.startsWith("youtube_") || platform.startsWith("instagram_") || platform.startsWith("tiktok_") ? "video" : null)
  );
}

/** Platforms of one group that this Studio actually publishes to. Single source
 * of truth for both the combined follower milestone and the dashboard's
 * audience filtering, so the two can't disagree about what counts.
 *
 * Community platforms (Threads, X) carry their own explicit
 * credentials and need no module gating. Telegram does: a controller bot is not
 * itself a publishing channel, and in a video-only Studio CHANNEL_USERNAME may
 * merely fall back to the legacy default, which would pull another creator's
 * audience into this dashboard. */
export function studioAudiencePlatforms(config: BackendConfig, group: AudienceGroup): string[] {
  return Object.entries(AUDIENCE_GROUPS)
    .filter(([platform, platformGroup]) => platformGroup === group && audiencePlatformEnabled(config, platform))
    .map(([platform]) => platform);
}

export function enabledAudiencePlatforms(config: BackendConfig): Set<string> {
  return new Set([...studioAudiencePlatforms(config, "text"), ...studioAudiencePlatforms(config, "video")]);
}

function audiencePlatformEnabled(config: BackendConfig, platform: string): boolean {
  if (platform === "telegram") return config.studio.modules.text_posting;
  if (platform === "youtube") return config.studio.modules.video_posting && config.studio.modules.youtube;
  if (platform === "instagram") return config.studio.modules.video_posting && config.studio.modules.instagram;
  return true;
}
