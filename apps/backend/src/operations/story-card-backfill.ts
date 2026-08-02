import { and, eq } from "drizzle-orm";
import { firstNonEmptyLine } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import { drafts, postLocales, publicationSources, publications, siteJobs, siteSourceItems } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { jsonObject } from "../json.js";
import { queueDraftStoryCards, readyStoryCardMedia, setStoryPublishMode, storyCardsForDraft } from "../story-cards/store.js";
import { runStoryCardCycle } from "../story-cards/worker.js";
import { resolvePublicationRef } from "./publication-ref.js";

type LocalePlan = { locale: "ru" | "en"; slug: string; headline: string };

/** Adds generated cards to an already-published site's empty locale media.
 * Social jobs and targets are deliberately outside this operation. */
export async function backfillTextStoryCards(
  backendDb: BackendDb,
  config: BackendConfig,
  input: string,
  apply: boolean,
  force = false,
): Promise<Record<string, unknown>> {
  const ref = resolvePublicationRef(backendDb, input);
  if (!ref?.postId) throw new Error(`publication not found: ${input}`);
  const publication = backendDb.db
    .select({ draftId: publications.draftId })
    .from(publications)
    .where(eq(publications.postId, ref.postId))
    .get();
  if (!publication?.draftId) throw new Error(`published draft not found: ${input}`);
  const draft = backendDb.db.select().from(drafts).where(eq(drafts.id, publication.draftId)).get();
  if (!draft) throw new Error(`draft ${publication.draftId} not found`);
  if (mediaCount(draft.mediaRuJson) > 0 || mediaCount(draft.mediaEnJson) > 0)
    throw new Error(`draft ${publication.draftId} already has original media`);

  const locales = backendDb.db
    .select({
      locale: postLocales.locale,
      slug: postLocales.slug,
      text: postLocales.text,
      mediaJson: postLocales.mediaJson,
    })
    .from(postLocales)
    .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.siteEnabled, 1)))
    .all();
  const plan = locales
    .filter(
      (locale) =>
        (mediaCount(locale.mediaJson) === 0 || (force && generatedMediaOnly(locale.mediaJson))) &&
        (locale.locale === "ru" || locale.locale === "en"),
    )
    .map(
      (locale): LocalePlan => ({
        locale: locale.locale as "ru" | "en",
        slug: locale.slug,
        headline: firstNonEmptyLine(locale.text),
      }),
    );
  const base = {
    post_id: ref.postId,
    post_key: ref.postKey,
    draft_id: publication.draftId,
    count: plan.length,
    force,
    plan,
  };
  if (!apply || plan.length === 0) return { ok: true, applied: false, ...base };

  queueDraftStoryCards(backendDb, publication.draftId);
  const cards = await waitForCards(backendDb, config, publication.draftId);
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    for (const item of plan) {
      const media = [cards[item.locale]];
      tx.update(postLocales)
        .set({ mediaJson: media, updatedAt: now })
        .where(and(eq(postLocales.postId, ref.postId as number), eq(postLocales.locale, item.locale)))
        .run();
    }
    const sourceRow = tx
      .select({ itemJson: publicationSources.itemJson })
      .from(publicationSources)
      .where(eq(publicationSources.postId, ref.postId as number))
      .get();
    const source = {
      ...jsonObject(sourceRow?.itemJson),
      ...(plan.some((item) => item.locale === "ru") ? { site_media_ru: [cards.ru] } : {}),
      ...(plan.some((item) => item.locale === "en") ? { site_media_en: [cards.en] } : {}),
    };
    tx.update(publicationSources)
      .set({ itemJson: source, updatedAt: now })
      .where(eq(publicationSources.postId, ref.postId as number))
      .run();
    const siteSource = tx
      .select({ itemJson: siteSourceItems.itemJson })
      .from(siteSourceItems)
      .where(eq(siteSourceItems.messageId, ref.messageId))
      .get();
    tx.insert(siteSourceItems)
      .values({ messageId: ref.messageId, itemJson: { ...jsonObject(siteSource?.itemJson), ...source }, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: siteSourceItems.messageId,
        set: { itemJson: { ...jsonObject(siteSource?.itemJson), ...source }, updatedAt: now },
      })
      .run();
    tx.insert(siteJobs)
      .values({
        postId: ref.postId,
        messageId: ref.messageId,
        reason: "text_story_card_backfill",
        status: "queued",
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  setStoryPublishMode(backendDb, publication.draftId, "site_only");
  return { ok: true, applied: true, ...base, cards: storyCardsForDraft(backendDb, publication.draftId) };
}

async function waitForCards(backendDb: BackendDb, config: BackendConfig, draftId: number) {
  const deadline = Date.now() + config.STORY_CARD_TIMEOUT_SECONDS * 2_000;
  while (Date.now() < deadline) {
    const ready = readyStoryCardMedia(backendDb, draftId);
    if (ready) return ready;
    await runStoryCardCycle(config, backendDb);
    await Bun.sleep(100);
  }
  const states = storyCardsForDraft(backendDb, draftId)
    .map((card) => `${card.locale}:${card.status}`)
    .join(", ");
  throw new Error(`Story card backfill timed out for draft ${draftId}: ${states}`);
}

function mediaCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function generatedMediaOnly(value: unknown): boolean {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => jsonObject(item).role === "text_story_card");
  } catch {
    return false;
  }
}
