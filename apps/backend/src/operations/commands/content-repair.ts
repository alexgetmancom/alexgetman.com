import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { drafts, postLocales, posts, publicationSources, siteJobs, siteSourceItems } from "../../db/schema.js";
import { jsonObject } from "../../json.js";
import type { PublicationRef } from "../publication-ref.js";

/** Repairs durable English content before Delivery rebuilds the site or retries a target. */
export function editEnglishContent(backendDb: BackendDb, ref: PublicationRef, text: string): Record<string, unknown> {
  const value = text.trim();
  if (!value) throw new Error("text_en is required");
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    if (ref.postId != null) {
      tx.update(drafts).set({ textEnApproved: value, updatedAt: now }).where(eq(drafts.postId, ref.postId)).run();
      tx.update(postLocales)
        .set({ text: value, updatedAt: now })
        .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, "en")))
        .run();
    }
    tx.update(posts).set({ textEn: value, updatedAt: now }).where(eq(posts.postKey, ref.postKey)).run();
    updateSource(tx, ref, { text_en: value, bodyMarkdown: value }, now);
    enqueueRepairSiteJob(tx, ref, "edit_en", now);
  });
  return { ok: true, post_id: ref.postId, post_key: ref.postKey, text_en: true };
}

export function replaceEnglishMedia(
  backendDb: BackendDb,
  ref: PublicationRef,
  media: Record<string, unknown>[] | null,
): Record<string, unknown> {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    if (ref.postId != null) {
      tx.update(drafts)
        .set({ mediaEnJson: media == null ? null : JSON.stringify(media), updatedAt: now })
        .where(eq(drafts.postId, ref.postId))
        .run();
      const ru = tx
        .select({ mediaJson: postLocales.mediaJson })
        .from(postLocales)
        .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, "ru")))
        .get();
      tx.update(postLocales)
        .set({ mediaJson: media == null ? (ru?.mediaJson ?? []) : media, updatedAt: now })
        .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, "en")))
        .run();
    }
    updateSource(tx, ref, { media_en: media }, now);
    enqueueRepairSiteJob(tx, ref, media == null ? "use_ru_media_for_en" : "replace_en_media", now);
  });
  return { ok: true, post_id: ref.postId, post_key: ref.postKey, media_en: media != null };
}

export function parseEnglishMedia(raw: string | undefined): Record<string, unknown>[] | null {
  if (!raw || ["none", "null", "ru", "fallback"].includes(raw.trim().toLowerCase())) return null;
  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!items || items.some((item) => !item || typeof item !== "object" || !(item as Record<string, unknown>).file_id))
    throw new Error("each media item needs file_id");
  return items as Record<string, unknown>[];
}

function updateSource(db: BackendDb["db"], ref: PublicationRef, patch: Record<string, unknown>, now: string): void {
  const row =
    ref.postId == null
      ? null
      : db
          .select({ itemJson: publicationSources.itemJson })
          .from(publicationSources)
          .where(eq(publicationSources.postId, ref.postId))
          .get();
  const source = { ...jsonObject(row?.itemJson), ...patch };
  if (ref.postId != null)
    db.update(publicationSources).set({ itemJson: source, updatedAt: now }).where(eq(publicationSources.postId, ref.postId)).run();
  const siteSource = db
    .select({ itemJson: siteSourceItems.itemJson })
    .from(siteSourceItems)
    .where(eq(siteSourceItems.messageId, ref.messageId))
    .get();
  db.insert(siteSourceItems)
    .values({ messageId: ref.messageId, itemJson: { ...jsonObject(siteSource?.itemJson), ...source }, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: siteSourceItems.messageId,
      set: { itemJson: { ...jsonObject(siteSource?.itemJson), ...source }, updatedAt: now },
    })
    .run();
}

function enqueueRepairSiteJob(db: BackendDb["db"], ref: PublicationRef, reason: string, now: string): void {
  db.insert(siteJobs)
    .values({ postId: ref.postId, messageId: ref.messageId, reason, status: "queued", nextAttemptAt: now, createdAt: now, updatedAt: now })
    .run();
}
