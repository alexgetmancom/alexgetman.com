export type TargetLocale = "ru" | "en";

export const TARGETS = [
  { id: "telegram", label: "Telegram", locale: "ru", kind: "telegram" },
  { id: "site_ru", label: "Site RU", locale: "ru", kind: "site" },
  { id: "site_en", label: "Site EN", locale: "en", kind: "site" },
  { id: "threads_ru", label: "Threads RU", locale: "ru", kind: "social" },
  { id: "threads_en", label: "Threads EN", locale: "en", kind: "social" },
  { id: "x", label: "X (Twitter)", locale: "en", kind: "social" },
  { id: "telegram_stories", label: "Telegram Stories", locale: "ru", kind: "social" },
  { id: "instagram_stories_ru", label: "Instagram Stories RU", locale: "ru", kind: "social" },
  { id: "instagram_stories", label: "Instagram Stories EN", locale: "en", kind: "social" },
] as const;

type TargetId = (typeof TARGETS)[number]["id"];

export const AUDIENCE_VIEWS = ["threads_ru", "threads_en", "telegram", "x"] as const;
export type AudienceView = (typeof AUDIENCE_VIEWS)[number];

export const TARGET_GROUPS = {
  threads: ["threads_ru", "threads_en"],
  x: ["x"],
  instagramStory: ["instagram_stories", "instagram_stories_ru"],
  telegramStory: ["telegram_stories"],
} as const;

const targetById = new Map<string, (typeof TARGETS)[number]>(TARGETS.map((target) => [target.id, target]));
const ALL_TARGETS = Object.fromEntries(TARGETS.map(({ id }) => [id, true])) as Record<TargetId, boolean>;

// X is normally published by hand, but remains selectable on the platform
// screen and in the explicit Full preset.
export const DEFAULT_TARGETS = { ...ALL_TARGETS, x: false } as Record<TargetId, boolean>;

export const PRESETS: Record<string, Record<TargetId, boolean>> = {
  full: { ...ALL_TARGETS },
  ru: Object.fromEntries(TARGETS.map(({ id, locale }) => [id, locale === "ru"])) as Record<TargetId, boolean>,
  en: Object.fromEntries(TARGETS.map(({ id, locale }) => [id, locale === "en"])) as Record<TargetId, boolean>,
  tg: Object.fromEntries(TARGETS.map(({ id }) => [id, id === "telegram"])) as Record<TargetId, boolean>,
};

export function targetLocale(target: string): TargetLocale | null {
  const definition = targetById.get(target);
  if (definition) return definition.locale;
  return null;
}

export function targetDefinition(target: string): (typeof TARGETS)[number] | null {
  return targetById.get(target) ?? null;
}

export function isKnownTarget(target: string): boolean {
  return targetById.has(target);
}

export function isSiteTarget(target: string): boolean {
  return targetById.get(target)?.kind === "site";
}

const STORY_TARGETS = new Set<string>([...TARGET_GROUPS.instagramStory, ...TARGET_GROUPS.telegramStory]);

export function targetInGroup(group: readonly string[], target: string): boolean {
  return group.includes(target);
}

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
    if (TARGETS.every(({ id }) => Boolean(targets[id]) === Boolean(preset[id]))) return name as keyof typeof PRESETS;
  }
  return "manual";
}
