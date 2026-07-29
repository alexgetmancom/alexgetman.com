import type { requireDraft } from "../content/drafts.js";
import { firstLine, parseArrayValue, slugify } from "../content/message.js";
import { entitiesToHtml } from "../content/text.js";
import type { postLocales } from "../db/schema.js";
import { parseTargets } from "./targets.js";

export type PublishMode = "immediate" | "scheduled";
type PublicationSchedule = { mode: PublishMode; ruAt: string | null; enAt: string | null };
type StoryCardMedia = Record<"ru" | "en", Record<string, unknown>>;

/** Pure publishing decision: draft content plus a schedule becomes a complete publication plan. */
export function createPublicationPlan(
  draft: ReturnType<typeof requireDraft>,
  draftId: number,
  postId: number,
  schedule: PublicationSchedule,
  now: string,
  availableTargets?: ReadonlySet<string>,
  storyCards?: StoryCardMedia,
) {
  const messageId = Number(draft.channel_message_id ?? postId);
  const postKey = `post:${postId}`;
  const mediaRu = parseArrayValue(draft.media_ru_json);
  const parsedMediaEn = parseArrayValue(draft.media_en_json);
  const mediaEn = parsedMediaEn.length > 0 ? parsedMediaEn : mediaRu;
  const entitiesRu = parseArrayValue(draft.text_ru_entities_json);
  const entitiesEn = parseArrayValue(draft.text_en_entities_json);
  const targets = Object.fromEntries(
    Object.entries(parseTargets(draft.targets_json)).map(([target, enabled]) => [
      target,
      (storyCards && isStoryTarget(target) ? draft.story_publish_mode === "all" : enabled) &&
        (!availableTargets || availableTargets.has(target)),
    ]),
  );
  const textRu = String(draft.text_ru ?? "");
  const textEn = String(draft.text_en_approved ?? draft.text_en_machine ?? draft.text_ru ?? "");
  const slugRu = slugify(firstLine(textRu), postId);
  const slugEn = slugify(firstLine(textEn), postId);
  const payload = {
    draft_id: draftId,
    post_id: postId,
    title: firstLine(textEn),
    text: textRu,
    text_ru: textRu,
    text_en: textEn,
    bodyMarkdown: textEn,
    media: mediaRu,
    media_en: mediaEn,
    story_media_ru: storyCards ? [storyCards.ru] : undefined,
    story_media_en: storyCards ? [storyCards.en] : undefined,
    site_media_ru: mediaRu.length ? mediaRu : storyCards ? [storyCards.ru] : [],
    site_media_en: mediaEn.length ? mediaEn : storyCards ? [storyCards.en] : [],
    entities_ru: entitiesRu,
    entities_en: entitiesEn,
    date: schedule.ruAt ?? schedule.enAt ?? now,
    publish_at_ru: schedule.ruAt,
    publish_at_en: schedule.enAt,
    targets,
    slug_ru: slugRu,
    slug_en: slugEn,
    has_ru: Boolean(targets.site_ru),
    has_en: Boolean(targets.site_en),
    // Copied into the durable payload rather than read from the draft at delivery
    // time: the draft can be edited or deleted while the job waits in the queue,
    // and the waiver has to describe the text that was actually planned.
    threads_chain_approved: Boolean(draft.threads_chain_approved),
  };
  const locale = (
    localeName: "ru" | "en",
    text: string,
    slug: string,
    media: Record<string, unknown>[],
    entities: Record<string, unknown>[],
    entitiesJson: unknown,
    enabled: boolean,
    publishedAt: string | null,
  ): typeof postLocales.$inferInsert => ({
    postId,
    locale: localeName,
    slug,
    text,
    html: entitiesToHtml(text, entities),
    entitiesJson: typeof entitiesJson === "string" ? entitiesJson : null,
    mediaJson: media,
    siteEnabled: enabled ? 1 : 0,
    publishedAt: enabled ? publishedAt : null,
    updatedAt: now,
  });
  return {
    draftId,
    postId,
    postKey,
    messageId,
    mode: schedule.mode,
    ruAt: schedule.ruAt,
    enAt: schedule.enAt,
    now,
    mediaRu,
    targets,
    textRu,
    textEn,
    payload,
    locales: [
      locale(
        "ru",
        textRu,
        slugRu,
        mediaRu.length ? mediaRu : storyCards ? [storyCards.ru] : [],
        entitiesRu,
        draft.text_ru_entities_json,
        Boolean(targets.site_ru),
        schedule.ruAt,
      ),
      locale(
        "en",
        textEn,
        slugEn,
        mediaEn.length ? mediaEn : storyCards ? [storyCards.en] : [],
        entitiesEn,
        draft.text_en_entities_json,
        Boolean(targets.site_en),
        schedule.enAt,
      ),
    ],
  };
}

function isStoryTarget(target: string): boolean {
  return target === "telegram_stories" || target === "instagram_stories_ru" || target === "instagram_stories";
}

export type PublicationPlan = ReturnType<typeof createPublicationPlan>;
