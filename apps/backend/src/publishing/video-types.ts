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
 * This list is the *bootstrap* catalogue, not the truth. The truth is the
 * channel registry: one row per account a Studio actually connected, which is
 * what lets a new destination appear by connecting it rather than by editing
 * this file. These four are what an installation has before it has a registry —
 * a fresh database or a fixture. See channels/destinations.ts.
 */
export const BOOTSTRAP_VIDEO_DESTINATIONS = [
  { target: "youtube_shorts", locale: "ru", label: "YouTube RU", profile: "youtube_ru" },
  { target: "youtube_shorts", locale: "en", label: "YouTube EN", profile: "youtube_en" },
  { target: "instagram_reels", locale: "ru", label: "Instagram RU", profile: "instagram_ru" },
  { target: "instagram_reels", locale: "en", label: "Instagram EN", profile: "instagram_en" },
] as const satisfies ReadonlyArray<{ target: VideoTarget; locale: VideoLocale; label: string; profile: string }>;

export type VideoDestination = { target: VideoTarget; locale: VideoLocale; label: string; profile: string };

export function videoDestination(
  catalogue: readonly VideoDestination[],
  target: string,
  locale: string | null | undefined,
): VideoDestination | null {
  return catalogue.find((entry) => entry.target === target && entry.locale === locale) ?? null;
}
