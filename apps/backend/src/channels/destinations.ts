import type { BackendDb } from "../db/client.js";
import {
  BOOTSTRAP_VIDEO_DESTINATIONS,
  VIDEO_TARGETS,
  type VideoDestination,
  type VideoLocale,
  type VideoTarget,
} from "../publishing/video-types.js";
import { listChannels } from "./registry.js";

/**
 * The video destinations this Studio actually has, read from the channel
 * registry.
 *
 * Every panel that names a channel, badges its language or counts its followers
 * asks here, so connecting an account is enough to make it appear. The static
 * catalogue is used only while the registry is empty — an un-bootstrapped
 * database or a fixture — because a hardcoded list is exactly what made adding
 * a destination a code change.
 *
 * The profile key is the connection id (`youtube_ru`, `instagram_en`), which is
 * also the key its audience snapshots are recorded under. That is not a
 * coincidence to preserve loosely: it is the same identity seen from publishing
 * and from analytics.
 */
export function videoDestinations(backendDb: BackendDb): VideoDestination[] {
  const channels = listChannels(backendDb).filter((channel) => VIDEO_PLATFORM_TARGET[channel.platform]);
  if (!channels.length) return [...BOOTSTRAP_VIDEO_DESTINATIONS];
  return channels.map((channel) => ({
    target: VIDEO_PLATFORM_TARGET[channel.platform] as VideoTarget,
    locale: (channel.locale === "en" ? "en" : "ru") as VideoLocale,
    label: channel.label,
    profile: channel.id,
  }));
}

/** Platforms the video pipeline can publish to, keyed by the registry's platform
 * name. A platform absent from here has no target to be delivered through, so a
 * channel for it would be a connection that never publishes. */
export const VIDEO_PLATFORM_TARGET: Record<string, VideoTarget | undefined> = {
  youtube: "youtube_shorts",
  instagram: "instagram_reels",
};

export function isPublishableVideoPlatform(platform: string): boolean {
  const target = VIDEO_PLATFORM_TARGET[platform];
  return Boolean(target && VIDEO_TARGETS.includes(target));
}
