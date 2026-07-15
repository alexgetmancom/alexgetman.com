import { TARGETS, type TargetLocale } from "../botTargets.js";

type PlatformProfile = {
  id: string;
  label: string;
  locale: TargetLocale;
  kind: "telegram" | "site" | "social";
  capabilities: { text: boolean; image: boolean; video: boolean };
  requirements: readonly string[];
  text?: { removeUrls?: boolean };
  video?: { landscape: readonly [number, number]; portrait: readonly [number, number]; square: readonly [number, number] };
};

const requirements: Record<string, readonly string[]> = {
  telegram: ["CONTROLLER_BOT_TOKEN"],
  threads_ru: ["THREADS_ACCESS_TOKEN"],
  threads_en: ["THREADS_EN_ACCESS_TOKEN"],
  facebook: ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"],
  facebook_ru: ["FACEBOOK_RU_PAGE_ID", "FACEBOOK_RU_PAGE_ACCESS_TOKEN"],
  linkedin: ["LINKEDIN_AUTHOR_URN", "LINKEDIN_ACCESS_TOKEN"],
  x: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
  bluesky: ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"],
  mastodon: ["MASTODON_INSTANCE", "MASTODON_ACCESS_TOKEN"],
  devto: ["DEVTO_API_KEY"],
  github_en: ["GITHUB_DISCUSSIONS_TOKEN"],
  github_ru: ["GITHUB_DISCUSSIONS_TOKEN"],
  telegram_stories: ["TELEGRAM_CHANNEL_STORIES_API_ID", "TELEGRAM_CHANNEL_STORIES_API_HASH", "TELEGRAM_CHANNEL_STORIES_SESSION"],
  instagram_stories: ["INSTAGRAM_EN_USER_ID", "INSTAGRAM_EN_ACCESS_TOKEN"],
  instagram_stories_ru: ["INSTAGRAM_RU_USER_ID", "INSTAGRAM_RU_ACCESS_TOKEN"],
};

const threadsVideo = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] } as const;

/** The single publishing-facing catalogue of a target's capabilities and runtime requirements. */
export const PLATFORM_PROFILES: Record<string, PlatformProfile> = Object.fromEntries(
  TARGETS.map(([id, label, locale, kind]) => [
    id,
    {
      id,
      label,
      locale,
      kind,
      capabilities: { text: true, image: kind !== "site", video: kind !== "site" },
      requirements: requirements[id] ?? [],
      ...(id === "x" ? { text: { removeUrls: true } } : {}),
      ...(id.startsWith("threads") ? { video: threadsVideo } : {}),
    },
  ]),
);

export function platformProfile(target: string): PlatformProfile | null {
  return PLATFORM_PROFILES[target] ?? null;
}

export function formatPlatformText(target: string, text: string): string {
  return platformProfile(target)?.text?.removeUrls
    ? text
        .replace(/https?:\/\/\S+/g, "")
        // Keep paragraph breaks: `\s` also matches newlines, which used to turn
        // two paragraphs into a single sentence on X after a URL was removed.
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .trim()
    : text;
}

export function videoBounds(target: string, width: number, height: number): { maxWidth: number; maxHeight: number } | null {
  const profile = platformProfile(target);
  const bounds = profile?.video;
  if (!bounds) return null;
  const [maxWidth, maxHeight] = width > height ? bounds.landscape : height > width ? bounds.portrait : bounds.square;
  return { maxWidth, maxHeight };
}
