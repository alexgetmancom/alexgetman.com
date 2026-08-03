import { isStoryTarget } from "../botTargets.js";
import { draftLocaleContent } from "../content/draft-content.js";
import type { requireDraft } from "../content/drafts.js";
import { firstLine, slugify } from "../content/message.js";
import { entitiesToHtml } from "../content/text.js";
import type { postLocales } from "../db/schema.js";
import { assertKnownTargets, parseTargets } from "./targets.js";

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
  const parsedTargets = parseTargets(draft.targets_json);
  assertKnownTargets(parsedTargets);
  const messageId = Number(draft.channel_message_id ?? postId);
  const postKey = `post:${postId}`;
  const contentRu = draftLocaleContent(draft, "ru");
  const contentEn = draftLocaleContent(draft, "en");
  const { media: mediaRu, entities: entitiesRu, text: textRu } = contentRu;
  const { media: mediaEn, entities: entitiesEn, text: textEn } = contentEn;
  const targets = Object.fromEntries(
    Object.entries(parsedTargets).map(([target, enabled]) => [
      target,
      // A generated card gates a Story target behind the editor's explicit
      // choice, but it never revives a target the editor switched off: the
      // choice narrows the selection, it does not replace it.
      enabled &&
        (storyCards && isStoryTarget(target) ? draft.story_publish_mode === "all" : true) &&
        (!availableTargets || availableTargets.has(target)),
    ]),
  );
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
    publishedAt: enabled ? (publishedAt ?? now) : null,
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

export type PublicationPlan = ReturnType<typeof createPublicationPlan>;
