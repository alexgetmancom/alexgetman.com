export type TargetLocale = "ru" | "en";

export const TARGETS = [
  ["telegram", "Telegram", "ru", "telegram"],
  ["site_ru", "Site RU", "ru", "site"],
  ["site_en", "Site EN", "en", "site"],
  ["threads_ru", "Threads RU", "ru", "social"],
  ["threads_en", "Threads EN", "en", "social"],
  ["x", "X (Twitter)", "en", "social"],
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

// X is normally published by hand, but remains selectable on the platform
// screen and in the explicit Full preset.
export const DEFAULT_TARGETS = { ...ALL_TARGETS, x: false } as Record<TargetId, boolean>;

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

const STORY_TARGETS = new Set<string>(["telegram_stories", "instagram_stories_ru", "instagram_stories"]);

/** Story targets take one media item and publish it full-bleed, which is why
 * generated text cards, Story-sized variants and the publish-mode gate all key
 * off this. Kept beside TARGETS so a fourth Story platform is one edit, not four. */
export function isStoryTarget(target: string): boolean {
  return STORY_TARGETS.has(target);
}

export type PresetName = keyof typeof PRESETS | "manual";

/** Names the preset a target selection matches, or "manual" when it matches none. */
export function presetName(targets: Record<string, boolean>): PresetName {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (TARGETS.every(([target]) => Boolean(targets[target]) === Boolean(preset[target]))) return name as keyof typeof PRESETS;
  }
  return "manual";
}
