import type { BackendDb } from "../db/client.js";
import {
  VIDEO_TARGET_PLATFORM,
  VIDEO_TARGETS,
  type VideoDestination,
  type VideoLocale,
  type VideoTarget,
} from "../publishing/video-types.js";
import { channelIdentity } from "./identity.js";
import { listChannels } from "./registry.js";

/**
 * The video destinations this Studio actually has, read from the channel
 * registry.
 *
 * Every panel that names a channel, badges its language or counts its followers
 * asks here, so connecting an account is enough to make it appear.
 *
 * The profile key is the connection id (`youtube_ru`, `instagram_en`), which is
 * also the key its audience snapshots are recorded under. That is not a
 * coincidence to preserve loosely: it is the same identity seen from publishing
 * and from analytics.
 */
export function videoDestinations(backendDb: BackendDb): VideoDestination[] {
  const channels = listChannels(backendDb).filter((channel) => VIDEO_PLATFORM_TARGET[channel.platform]);
  return channels
    .map((channel) => ({
      target: VIDEO_PLATFORM_TARGET[channel.platform] as VideoTarget,
      locale: (channel.locale === "en" ? "en" : "ru") as VideoLocale,
      label: channel.label,
      profile: channel.id,
    }))
    .sort(
      (left, right) =>
        VIDEO_TARGETS.indexOf(left.target) - VIDEO_TARGETS.indexOf(right.target) ||
        (left.locale === right.locale ? 0 : left.locale === "ru" ? -1 : 1),
    );
}

/** Platforms the video pipeline can publish to, keyed by the registry's platform
 * name. A platform absent from here has no target to be delivered through, so a
 * channel for it would be a connection that never publishes. */
const VIDEO_PLATFORM_TARGET: Record<string, VideoTarget | undefined> = Object.fromEntries(
  Object.entries(VIDEO_TARGET_PLATFORM).map(([target, platform]) => [platform, target]),
) as Record<string, VideoTarget | undefined>;

export function isPublishableVideoPlatform(platform: string): boolean {
  const target = VIDEO_PLATFORM_TARGET[platform];
  return Boolean(target && VIDEO_TARGETS.includes(target));
}

/** Credential checks, token probes and delivery failures all name the same
 * connected account. Historical work can outlive a disabled registry row, so
 * the deterministic platform/locale id remains its identity fallback. */
export function videoChannelIdentity(backendDb: BackendDb, target: VideoTarget, locale: VideoLocale): string {
  const platform = VIDEO_TARGET_PLATFORM[target];
  return backendDb.channels.find(platform, locale)?.id ?? channelIdentity(platform, locale);
}
