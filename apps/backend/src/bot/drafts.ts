import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { DEFAULT_TARGETS, isSiteTarget, targetLocale } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import {
  drafts,
  postControlCards,
  postLocales,
  posts,
  publicationPlans,
  publicationSources,
  publications,
  publishJobs,
  siteJobs,
  siteSourceItems,
} from "../db/schema.js";
import { localizeTargetPayload } from "../publishing/payload.js";
import { enqueuePublishJobTx, reconcilePublication } from "../publishing/queue.js";
import { rebalanceScheduledDrafts } from "../publishing/schedule.js";
import { type DraftMessage, firstLine, parseArrayValue, parseTargets, slugify } from "./message.js";
import { entitiesToHtml } from "./text.js";

type PublishDraftOptions = { mode?: "immediate" | "scheduled"; ruAt?: Date | null; enAt?: Date | null };

export function createDraftFromMessage(backendDb: BackendDb, adminId: number, message: DraftMessage): number {
  const now = new Date().toISOString();
  const created = backendDb.db
    .insert(drafts)
    .values({
      adminId,
      status: "needs_review",
      textRu: message.text,
      textEnMachine: message.textEn ?? message.text,
      textEnApproved: message.textEn ?? message.text,
      targetsJson: JSON.stringify(DEFAULT_TARGETS),
      mediaRuJson: message.media.length ? JSON.stringify(message.media) : null,
      textRuEntitiesJson: JSON.stringify(message.entities),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: drafts.id })
    .get();
  if (!created) throw new Error("draft insert did not return an id");
  return created.id;
}

export function scheduledDrafts(backendDb: BackendDb): Array<{ id: number; scheduledAt: string | null; scheduledEnAt: string | null }> {
  return backendDb.db
    .select({ id: drafts.id, scheduledAt: drafts.scheduledAt, scheduledEnAt: drafts.scheduledEnAt })
    .from(drafts)
    .where(eq(drafts.status, "scheduled"))
    .orderBy(asc(sql`coalesce(${drafts.scheduledAt}, ${drafts.scheduledEnAt})`), asc(drafts.id))
    .all();
}

export function requireDraft(backendDb: BackendDb, draftId: number) {
  const draft = backendDb.db
    .select({
      id: drafts.id,
      status: drafts.status,
      text_ru: drafts.textRu,
      text_en_machine: drafts.textEnMachine,
      text_en_approved: drafts.textEnApproved,
      targets_json: drafts.targetsJson,
      media_ru_json: drafts.mediaRuJson,
      media_en_json: drafts.mediaEnJson,
      channel_message_id: drafts.channelMessageId,
      scheduled_at: drafts.scheduledAt,
      scheduled_en_at: drafts.scheduledEnAt,
      text_ru_entities_json: drafts.textRuEntitiesJson,
      text_en_entities_json: drafts.textEnEntitiesJson,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  if (!draft) throw new Error(`draft ${draftId} not found`);
  return draft;
}

export function hasLocaleTarget(targets: Record<string, boolean>, locale: "ru" | "en"): boolean {
  return Object.entries(targets).some(([target, enabled]) => enabled && targetLocale(target) === locale);
}

export function cancelDraft(backendDb: BackendDb, draftId: number): void {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    const publication = tx.select({ postId: publications.postId }).from(publications).where(eq(publications.draftId, draftId)).get();
    const postId = publication?.postId;
    tx.update(drafts)
      .set({ status: "cancelled", scheduledAt: null, scheduledEnAt: null, updatedAt: now })
      .where(eq(drafts.id, draftId))
      .run();
    if (!postId) return;
    tx.update(publications).set({ status: "cancelled", updatedAt: now }).where(eq(publications.postId, postId)).run();
    const finalCount =
      tx
        .select({ count: count() })
        .from(publishJobs)
        .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["publishing", "published", "skipped"])))
        .get()?.count ?? 0;
    if (finalCount > 0) {
      tx.update(publishJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["queued", "failed"])))
        .run();
      tx.update(siteJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(siteJobs.postId, postId), inArray(siteJobs.status, ["queued", "failed"])))
        .run();
      return;
    }
    tx.delete(publishJobs).where(eq(publishJobs.postId, postId)).run();
    tx.delete(siteJobs).where(eq(siteJobs.postId, postId)).run();
    tx.delete(publicationPlans).where(eq(publicationPlans.postId, postId)).run();
    tx.delete(publicationSources).where(eq(publicationSources.postId, postId)).run();
    tx.delete(postLocales).where(eq(postLocales.postId, postId)).run();
    tx.delete(posts).where(eq(posts.postId, postId)).run();
    tx.delete(publications).where(eq(publications.postId, postId)).run();
    tx.update(drafts).set({ postId: null, updatedAt: now }).where(eq(drafts.id, draftId)).run();
  });
  rebalanceScheduledDrafts(backendDb);
}

export function setDraftControlCard(backendDb: BackendDb, draftId: number, chatId: number, messageId: number): void {
  backendDb.db
    .insert(postControlCards)
    .values({ draftId, chatId, messageId, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: postControlCards.draftId, set: { chatId, messageId, updatedAt: new Date().toISOString() } })
    .run();
}

export function publishDraftToQueue(backendDb: BackendDb, draftId: number, options: PublishDraftOptions = {}): number {
  const draft = requireDraft(backendDb, draftId);
  const now = new Date().toISOString();
  const mode = options.mode ?? "immediate";
  const ruAt = mode === "immediate" ? now : (options.ruAt?.toISOString() ?? null);
  const enAt = mode === "immediate" ? now : (options.enAt?.toISOString() ?? null);
  const existing = backendDb.db.select({ postId: publications.postId }).from(publications).where(eq(publications.draftId, draftId)).get();
  const inserted =
    existing?.postId == null
      ? backendDb.db
          .insert(publications)
          .values({ status: "scheduled", draftId, createdAt: now, updatedAt: now })
          .returning({ postId: publications.postId })
          .get()
      : null;
  const postId = existing?.postId ?? inserted?.postId;
  if (postId == null) throw new Error("publication insert did not return an id");
  const prepared = prepareDraftPublication(draft, draftId, postId, ruAt, enAt, now);
  const { messageId, postKey, mediaRu, targets, textRu, textEn, payload, ruLocale, enLocale } = prepared;

  backendDb.db.transaction((tx) => {
    const postValues = {
      postId,
      source: "bot",
      channel: "controller",
      messageId,
      dateUtc: ruAt ?? enAt ?? now,
      text: textRu,
      textEn,
      mediaJson: JSON.stringify(mediaRu),
      mediaCount: mediaRu.length,
      createdAt: now,
      updatedAt: now,
      rawJson: JSON.stringify(payload),
    };
    tx.insert(posts)
      .values({ postKey, ...postValues })
      .onConflictDoUpdate({
        target: posts.postKey,
        set: {
          postId,
          dateUtc: postValues.dateUtc,
          text: textRu,
          textEn,
          mediaJson: postValues.mediaJson,
          mediaCount: mediaRu.length,
          updatedAt: now,
          rawJson: postValues.rawJson,
        },
      })
      .run();
    for (const locale of [ruLocale, enLocale])
      tx.insert(postLocales)
        .values(locale)
        .onConflictDoUpdate({
          target: [postLocales.postId, postLocales.locale],
          set: {
            slug: locale.slug,
            text: locale.text,
            html: locale.html,
            entitiesJson: locale.entitiesJson,
            mediaJson: locale.mediaJson,
            siteEnabled: locale.siteEnabled,
            publishedAt: locale.publishedAt,
            updatedAt: now,
          },
        })
        .run();
    const plan = { draft_id: draftId, targets, scheduled_at: ruAt, scheduled_en_at: enAt, created_at: now };
    tx.insert(publicationPlans)
      .values({ postId, planJson: plan, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: publicationPlans.postId, set: { planJson: plan, updatedAt: now } })
      .run();
    tx.insert(publicationSources)
      .values({ postId, itemJson: payload, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: publicationSources.postId, set: { itemJson: payload, updatedAt: now } })
      .run();
    tx.insert(siteSourceItems)
      .values({ messageId, itemJson: payload, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: siteSourceItems.messageId, set: { itemJson: payload, updatedAt: now } })
      .run();
    tx.delete(publishJobs)
      .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["queued", "failed"])))
      .run();
    tx.delete(siteJobs)
      .where(and(eq(siteJobs.postId, postId), inArray(siteJobs.status, ["queued", "failed"])))
      .run();
    const finalTargets = new Set(
      tx
        .select({ target: publishJobs.target })
        .from(publishJobs)
        .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["publishing", "published", "skipped"])))
        .all()
        .map((row) => row.target),
    );
    for (const [target, enabled] of Object.entries(targets)) {
      if (enabled && !isSiteTarget(target) && !finalTargets.has(target))
        enqueuePublishJobTx(tx, {
          postId,
          postKey,
          messageId,
          target,
          payload: localizeTargetPayload(payload, target),
          publishAt: targetLocale(target) === "en" ? enAt : ruAt,
        });
    }
    for (const [locale, enabled, publishAt] of [
      ["ru", targets.site_ru, ruAt],
      ["en", targets.site_en, enAt],
    ] as const) {
      if (enabled && publishAt)
        tx.insert(siteJobs)
          .values({
            postId,
            messageId,
            reason: `publish_${locale}`,
            status: "queued",
            nextAttemptAt: publishAt,
            createdAt: now,
            updatedAt: now,
          })
          .run();
    }
    tx.update(drafts)
      .set({
        status: "scheduled",
        postId,
        publishMode: mode,
        scheduledAt: ruAt,
        scheduledEnAt: enAt,
        updatedAt: now,
      })
      .where(eq(drafts.id, draftId))
      .run();
    tx.update(publications).set({ status: "scheduled", updatedAt: now }).where(eq(publications.postId, postId)).run();
  });
  // A publication without enabled targets is immediately complete. Every
  // ordinary publication remains scheduled until its jobs reconcile.
  reconcilePublication(backendDb, postId);
  return postId;
}

function prepareDraftPublication(
  draft: ReturnType<typeof requireDraft>,
  draftId: number,
  postId: number,
  ruAt: string | null,
  enAt: string | null,
  now: string,
) {
  const messageId = Number(draft.channel_message_id ?? postId);
  const postKey = `post:${postId}`;
  const mediaRu = parseArrayValue(draft.media_ru_json);
  const parsedMediaEn = parseArrayValue(draft.media_en_json);
  const mediaEn = parsedMediaEn.length > 0 ? parsedMediaEn : mediaRu;
  const entitiesRu = parseArrayValue(draft.text_ru_entities_json);
  const entitiesEn = parseArrayValue(draft.text_en_entities_json);
  const targets = parseTargets(draft.targets_json);
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
    entities_ru: entitiesRu,
    entities_en: entitiesEn,
    date: ruAt ?? enAt ?? now,
    publish_at_ru: ruAt,
    publish_at_en: enAt,
    targets,
    slug_ru: slugRu,
    slug_en: slugEn,
    has_ru: Boolean(targets.site_ru),
    has_en: Boolean(targets.site_en),
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
    messageId,
    postKey,
    mediaRu,
    targets,
    textRu,
    textEn,
    payload,
    ruLocale: locale("ru", textRu, slugRu, mediaRu, entitiesRu, draft.text_ru_entities_json, Boolean(targets.site_ru), ruAt),
    enLocale: locale("en", textEn, slugEn, mediaEn, entitiesEn, draft.text_en_entities_json, Boolean(targets.site_en), enAt),
  };
}
