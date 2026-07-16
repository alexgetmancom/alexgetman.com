export type TargetLocale = "ru" | "en";

export const TARGETS = [
  ["telegram", "Telegram", "ru", "telegram"],
  ["site_ru", "Site RU", "ru", "site"],
  ["site_en", "Site EN", "en", "site"],
  ["threads_ru", "Threads RU", "ru", "social"],
  ["facebook_ru", "Facebook RU", "ru", "social"],
  ["linkedin", "LinkedIn", "en", "social"],
  ["facebook", "Facebook EN", "en", "social"],
  ["threads_en", "Threads EN", "en", "social"],
  ["x", "X (Twitter)", "en", "social"],
  ["bluesky", "Bluesky", "en", "social"],
  ["mastodon", "Mastodon", "en", "social"],
  ["devto", "dev.to", "en", "social"],
  ["github_en", "GitHub EN", "en", "social"],
  ["github_ru", "GitHub RU", "ru", "social"],
  ["telegram_stories", "Telegram Stories", "ru", "social"],
  ["instagram_stories_ru", "Instagram Stories RU", "ru", "social"],
  ["instagram_stories", "Instagram Stories EN", "en", "social"],
] as const;

type TargetId = (typeof TARGETS)[number][0];

const targetById = Object.fromEntries(TARGETS.map(([id, label, locale, kind]) => [id, { id, label, locale, kind }])) as Record<
  TargetId,
  { id: TargetId; label: string; locale: TargetLocale; kind: "telegram" | "site" | "social" }
>;
const ALL_TARGETS = Object.fromEntries(TARGETS.map(([id]) => [id, true])) as Record<TargetId, boolean>;

// A new ordinary post starts in a deliberately manual state. LinkedIn is
// temporarily restricted and X is normally published by hand; both remain
// selectable on the platform screen and in the explicit Full preset.
export const DEFAULT_TARGETS = { ...ALL_TARGETS, linkedin: false, x: false } as Record<TargetId, boolean>;

export const PRESETS: Record<string, Record<TargetId, boolean>> = {
  full: { ...ALL_TARGETS },
  ru: Object.fromEntries(TARGETS.map(([id, , locale]) => [id, locale === "ru"])) as Record<TargetId, boolean>,
  en: Object.fromEntries(TARGETS.map(([id, , locale]) => [id, locale === "en"])) as Record<TargetId, boolean>,
  tg: Object.fromEntries(TARGETS.map(([id]) => [id, id === "telegram"])) as Record<TargetId, boolean>,
};

export function targetLocale(target: string): TargetLocale | null {
  return targetById[target as TargetId]?.locale ?? null;
}

export function isSiteTarget(target: string): boolean {
  return targetById[target as TargetId]?.kind === "site";
}
