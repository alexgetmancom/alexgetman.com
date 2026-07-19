import { TARGETS, type TargetLocale } from "../botTargets.js";

type PlatformId = (typeof TARGETS)[number][0];
type MediaMode = "all" | "limited" | "first" | "story-first";
type MediaRule = { mode: MediaMode; limit?: number; label?: string; note?: string };

type PlatformProfile = {
  id: string;
  label: string;
  locale: TargetLocale;
  kind: "telegram" | "site" | "social";
  capabilities: { text: boolean; image: boolean; video: boolean };
  requirements: readonly string[];
  text?: { removeUrls?: boolean };
  limits?: { text?: number; caption?: number; media?: number };
  /** Delivery-facing media contract. Interfaces use this for previews; ports own execution. */
  media?: MediaRule & { whenVideo?: MediaRule };
  video?: { landscape: readonly [number, number]; portrait: readonly [number, number]; square: readonly [number, number] };
  analytics?: { enabled: boolean; source: string };
};

const analyticsSources: Record<string, string> = {
  telegram: "t_me_public",
  threads_ru: "threads_insights_api",
  threads_en: "threads_insights_api",
  facebook: "facebook_insights_api",
  facebook_ru: "facebook_insights_api",
  linkedin: "linkedin_metrics",
  x: "x_api",
  bluesky: "bluesky_public_api",
  mastodon: "mastodon_public_api",
  devto: "devto_api_authenticated",
  github_en: "github_graphql",
  github_ru: "github_graphql",
  telegram_stories: "telegram_story_api",
  instagram_stories: "instagram_graph_api",
  instagram_stories_ru: "instagram_graph_api",
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

/**
 * Every current post target is described here. This is intentionally data, not
 * a set of target checks spread between UI and delivery code. A new target gets
 * its locale, capabilities, limits and media semantics in one place.
 */
const platformOverrides: Record<PlatformId, Omit<PlatformProfile, "id" | "label" | "locale" | "kind" | "requirements">> = {
  telegram: {
    capabilities: { text: true, image: true, video: true },
    limits: { text: 4096, caption: 1024, media: 10 },
    media: { mode: "limited", limit: 10, label: "Telegram" },
  },
  site_ru: { capabilities: { text: true, image: true, video: false }, media: { mode: "all" } },
  site_en: { capabilities: { text: true, image: true, video: false }, media: { mode: "all" } },
  threads_ru: { capabilities: { text: true, image: true, video: true }, media: { mode: "all" }, video: threadsVideo },
  facebook_ru: {
    capabilities: { text: true, image: true, video: true },
    media: { mode: "all", whenVideo: { mode: "first", note: "Facebook publishes the first video when the selection contains video." } },
  },
  linkedin: { capabilities: { text: true, image: true, video: true }, media: { mode: "limited", limit: 20, label: "LinkedIn" } },
  facebook: {
    capabilities: { text: true, image: true, video: true },
    media: { mode: "all", whenVideo: { mode: "first", note: "Facebook publishes the first video when the selection contains video." } },
  },
  threads_en: { capabilities: { text: true, image: true, video: true }, media: { mode: "all" }, video: threadsVideo },
  x: { capabilities: { text: true, image: true, video: true }, text: { removeUrls: true }, media: { mode: "all" } },
  bluesky: { capabilities: { text: true, image: true, video: true }, media: { mode: "limited", limit: 4, label: "Bluesky" } },
  mastodon: { capabilities: { text: true, image: true, video: true }, media: { mode: "limited", limit: 4, label: "Mastodon" } },
  devto: {
    capabilities: { text: true, image: true, video: false },
    media: { mode: "first", note: "Dev.to uses the first image as its cover and inline image." },
  },
  github_en: { capabilities: { text: true, image: true, video: true }, media: { mode: "all" } },
  github_ru: { capabilities: { text: true, image: true, video: true }, media: { mode: "all" } },
  telegram_stories: {
    capabilities: { text: true, image: true, video: true },
    media: { mode: "story-first", note: "Stories use a single rendered asset made from the first source item." },
  },
  instagram_stories_ru: {
    capabilities: { text: true, image: true, video: true },
    media: { mode: "story-first", note: "Stories use a single rendered asset made from the first source item." },
  },
  instagram_stories: {
    capabilities: { text: true, image: true, video: true },
    media: { mode: "story-first", note: "Stories use a single rendered asset made from the first source item." },
  },
};

/** The single publishing-facing catalogue of a target's capabilities and runtime requirements. */
export const PLATFORM_PROFILES: Record<string, PlatformProfile> = Object.fromEntries(
  TARGETS.map(([id, label, locale, kind]) => [
    id,
    {
      id,
      label,
      locale,
      kind,
      requirements: requirements[id] ?? [],
      analytics: analyticsSources[id] ? { enabled: true, source: analyticsSources[id] } : { enabled: false, source: "unsupported" },
      ...platformOverrides[id],
    },
  ]),
);

export function platformProfile(target: string): PlatformProfile | null {
  return PLATFORM_PROFILES[target] ?? null;
}

/** Display label for a platform group that combines several locale-specific
 * targets into one dashboard column (e.g. `github_en`/`github_ru` → "GitHub").
 * Grouping itself is dashboard presentation (see operations/dashboard's
 * platformKey); only the label text belongs in the platform catalogue. */
const PLATFORM_GROUP_LABELS: Record<string, string> = {
  x: "X (Twitter)",
  github: "GitHub",
  devto: "dev.to",
};

export function platformGroupLabel(key: string): string {
  return PLATFORM_GROUP_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** One catalogue for publishing, validation and analytics capability. */
export function platformAnalyticsProfile(target: string): { enabled: boolean; source: string } {
  return platformProfile(target)?.analytics ?? { enabled: false, source: "unsupported" };
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
