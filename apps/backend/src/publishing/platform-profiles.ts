import { TARGETS, type TargetLocale } from "../botTargets.js";

type PlatformId = (typeof TARGETS)[number][0];
/** A discriminated union on purpose: a `limited` rule without its limit/label, or
 * a first/story-first rule without its note, used to type-check and then degrade
 * silently into "deliver everything" inside mediaPolicyForTarget — the opposite
 * of what the profile declared. Each mode now carries what it needs to be applied. */
type MediaRule = { mode: "all" } | { mode: "limited"; limit: number; label: string } | { mode: "first" | "story-first"; note: string };

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
  x: "x_api",
  telegram_stories: "telegram_story_api",
  instagram_stories: "instagram_graph_api",
  instagram_stories_ru: "instagram_graph_api",
};

const requirements: Record<string, readonly string[]> = {
  telegram: ["CONTROLLER_BOT_TOKEN"],
  threads_ru: ["THREADS_ACCESS_TOKEN"],
  threads_en: ["THREADS_EN_ACCESS_TOKEN"],
  x: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
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
  threads_en: { capabilities: { text: true, image: true, video: true }, media: { mode: "all" }, video: threadsVideo },
  x: { capabilities: { text: true, image: true, video: true }, text: { removeUrls: true }, media: { mode: "all" } },
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
