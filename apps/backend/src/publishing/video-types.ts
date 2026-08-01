/** Video-target vocabulary belongs to Publishing, independent of any UI. */
export const VIDEO_TARGETS = ["youtube_shorts", "instagram_reels"] as const;
export type VideoTarget = (typeof VIDEO_TARGETS)[number];
export type VideoLocale = "ru" | "en";

export type YouTubeMetadata = { title: string; description: string; tags: string[]; gameUrl?: string };
/** Instagram receives one ready-to-publish caption, including any hashtags. */
export type InstagramMetadata = { caption: string };
export type VideoMetadata = YouTubeMetadata | InstagramMetadata;

export function videoTargetLabel(target: VideoTarget): string {
  return target === "youtube_shorts" ? "YouTube Shorts" : "Instagram Reels";
}

/**
 * Where a clip actually lands: a platform *and* a language, which together name
 * one real account.
 *
 * A target alone does not identify a destination. One Studio publishes Shorts
 * to two YouTube channels — a Russian one and an English one — and picks
 * between them by the draft's locale; the audience snapshots have recorded that
 * split for a long time (`youtube_ru`, `youtube_en`, ...) while the publishing
 * vocabulary still only knew "youtube_shorts". Anything that wants to name a
 * destination, count its followers, or badge its language had to guess from the
 * drafts that happened to go out, which says nothing on a quiet week.
 *
 * This is the video counterpart of TARGETS in botTargets.ts, which has always
 * carried a locale per text target. It is a catalogue, not a per-account
 * setting: which of these a Studio actually uses is answered by its data and by
 * its module flags, not by a second copy of this list in every studio.yaml.
 */
export const VIDEO_DESTINATIONS = [
  { target: "youtube_shorts", locale: "ru", label: "YouTube RU", profile: "youtube_ru" },
  { target: "youtube_shorts", locale: "en", label: "YouTube EN", profile: "youtube_en" },
  { target: "instagram_reels", locale: "ru", label: "Instagram RU", profile: "instagram_ru" },
  { target: "instagram_reels", locale: "en", label: "Instagram EN", profile: "instagram_en" },
] as const satisfies ReadonlyArray<{ target: VideoTarget; locale: VideoLocale; label: string; profile: string }>;

export type VideoDestination = (typeof VIDEO_DESTINATIONS)[number];

/** Profile keys predating the locale split. They still receive snapshots, so a
 * destination falls back to them when its own key has none yet. */
const LEGACY_PROFILE: Record<VideoTarget, string> = { youtube_shorts: "youtube", instagram_reels: "instagram" };
/** A pre-split key names the platform without a language, because it is the
 * account of a Studio that only ever had one. */
const LEGACY_PROFILE_LABEL: Record<VideoTarget, string> = { youtube_shorts: "YouTube", instagram_reels: "Instagram" };

export function legacyVideoProfile(target: VideoTarget): string {
  return LEGACY_PROFILE[target];
}

/** Every profile key the audience snapshots may carry, newest naming first. The
 * legacy keys stay in the list because old snapshots are never rewritten. */
export const VIDEO_PROFILE_KEYS: readonly string[] = [
  ...VIDEO_DESTINATIONS.map((destination) => destination.profile),
  ...VIDEO_TARGETS.map((target) => LEGACY_PROFILE[target]),
];

/** Names a profile key for display, so a new destination is added to the
 * catalogue alone rather than to every panel that renders one. */
export function videoProfileLabel(profile: string): string {
  const destination = VIDEO_DESTINATIONS.find((entry) => entry.profile === profile);
  if (destination) return destination.label;
  const legacy = VIDEO_TARGETS.find((target) => LEGACY_PROFILE[target] === profile);
  return legacy ? LEGACY_PROFILE_LABEL[legacy] : profile;
}

export function videoDestination(target: string, locale: string | null | undefined): VideoDestination | null {
  return VIDEO_DESTINATIONS.find((entry) => entry.target === target && entry.locale === locale) ?? null;
}
