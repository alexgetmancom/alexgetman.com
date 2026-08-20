export type TargetLocale = "ru" | "en";

/** What a target can carry. The site renders both a short post and a long
 * article, X carries a post at `x` and an Article at `x_article`; nothing
 * branches on the distinction, callers ask the catalogue for the kind they
 * are publishing. */
export type PublicationForm = "post" | "article";

export const TARGETS = [
  { id: "telegram", label: "Telegram", locale: "ru", kind: "telegram", carries: ["post"] },
  { id: "site_ru", label: "Site RU", locale: "ru", kind: "site", carries: ["post", "article"] },
  { id: "site_en", label: "Site EN", locale: "en", kind: "site", carries: ["post", "article"] },
  { id: "threads_ru", label: "Threads RU", locale: "ru", kind: "social", carries: ["post"] },
  { id: "threads_en", label: "Threads EN", locale: "en", kind: "social", carries: ["post"] },
  { id: "x", label: "X (Twitter)", locale: "en", kind: "social", carries: ["post"] },
  { id: "x_article", label: "X Article", locale: "en", kind: "social", carries: ["article"] },
  { id: "discord", label: "Discord", locale: "en", kind: "social", carries: ["post"] },
  { id: "telegram_stories", label: "Telegram Stories", locale: "ru", kind: "social", carries: ["post"] },
  { id: "instagram_stories_ru", label: "Instagram Stories RU", locale: "ru", kind: "social", carries: ["post"] },
  { id: "instagram_stories", label: "Instagram Stories EN", locale: "en", kind: "social", carries: ["post"] },
] as const;

type TargetId = (typeof TARGETS)[number]["id"];

/** The targets that carry one form of publication. Post flows and article flows
 * read this instead of the whole catalogue, so a target only ever appears where
 * it can actually deliver. */
export function targetsFor(form: PublicationForm): readonly (typeof TARGETS)[number][] {
  return TARGETS.filter((target) => (target.carries as readonly string[]).includes(form));
}

/** The same list as ids, for schemas that have to enumerate them. Spelling a
 * list a second time is how a target ends up connectable but unpublishable. */
export function targetIdsFor(form: PublicationForm): [TargetId, ...TargetId[]] {
  return targetsFor(form).map(({ id }) => id) as unknown as [TargetId, ...TargetId[]];
}

export const AUDIENCE_VIEWS = ["threads_ru", "threads_en", "telegram", "x"] as const;
export type AudienceView = (typeof AUDIENCE_VIEWS)[number];

export const TARGET_GROUPS = {
  threads: ["threads_ru", "threads_en"],
  x: ["x"],
  xArticle: ["x_article"],
  discord: ["discord"],
  instagramStory: ["instagram_stories", "instagram_stories_ru"],
  telegramStory: ["telegram_stories"],
} as const;

const targetById = new Map<string, (typeof TARGETS)[number]>(TARGETS.map((target) => [target.id, target]));
const ALL_POST_TARGETS = Object.fromEntries(targetsFor("post").map(({ id }) => [id, true])) as Record<TargetId, boolean>;

/** A selection of target ids as the on/off record every draft and preset uses.
 * Ids the catalogue does not know are dropped, so a target retired after a
 * Studio saved its defaults degrades to "off" instead of a broken record. */
export function targetsRecord(selected: readonly string[], form: PublicationForm = "post"): Record<string, boolean> {
  const unique = new Set(selected);
  return Object.fromEntries(targetsFor(form).map(({ id }) => [id, unique.has(id)]));
}

export const PRESETS: Record<string, Record<TargetId, boolean>> = {
  full: { ...ALL_POST_TARGETS },
  ru: Object.fromEntries(targetsFor("post").map(({ id, locale }) => [id, locale === "ru"])) as Record<TargetId, boolean>,
  en: Object.fromEntries(targetsFor("post").map(({ id, locale }) => [id, locale === "en"])) as Record<TargetId, boolean>,
  tg: Object.fromEntries(targetsFor("post").map(({ id }) => [id, id === "telegram"])) as Record<TargetId, boolean>,
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
