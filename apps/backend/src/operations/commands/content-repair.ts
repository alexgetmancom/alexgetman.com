import { and, eq, inArray, isNull } from "drizzle-orm";
import type { UnsafeBackendDb } from "../../db/client.js";
import { drafts, postLocales, posts, publicationSources, siteJobs, siteSourceItems } from "../../db/schema.js";
import { jsonObject } from "../../json.js";
import type { ResolvedPublicationRef } from "../publication-ref.js";

/** Repairs durable English content before Delivery rebuilds the site or retries a target. */
export function editLocaleContentTx(
  db: UnsafeBackendDb["db"],
  ref: ResolvedPublicationRef,
  locale: "ru" | "en",
  text: string,
): Record<string, unknown> {
  const value = text.trim();
  if (!value) throw new Error(`text_${locale} is required`);
  const now = new Date().toISOString();
  if (ref.postId != null) {
    db.update(drafts)
      .set(locale === "en" ? { textEnApproved: value, updatedAt: now } : { textRu: value, updatedAt: now })
      .where(eq(drafts.postId, ref.postId))
      .run();
    db.update(postLocales)
      .set({ text: value, updatedAt: now })
      .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, locale)))
      .run();
  }
  db.update(posts)
    .set(locale === "en" ? { textEn: value, updatedAt: now } : { text: value, updatedAt: now })
    .where(eq(posts.postKey, ref.postKey))
    .run();
  updateSource(db, ref, locale === "en" ? { text_en: value, bodyMarkdown: value } : { text_ru: value, text: value }, now);
  enqueueRepairSiteJob(db, ref, `edit_${locale}`, now);
  return {
    ok: true,
    post_id: ref.postId,
    post_key: ref.postKey,
    locale,
    text: true,
    ...(locale === "en" ? { text_en: true } : { text_ru: true }),
  };
}

export function replaceLocaleMediaTx(
  db: UnsafeBackendDb["db"],
  ref: ResolvedPublicationRef,
  locale: "ru" | "en",
  media: Record<string, unknown>[] | null,
): Record<string, unknown> {
  const now = new Date().toISOString();
  if (ref.postId != null) {
    db.update(drafts)
      .set(
        locale === "en"
          ? { mediaEnJson: media == null ? null : JSON.stringify(media), updatedAt: now }
          : { mediaRuJson: JSON.stringify(media ?? []), updatedAt: now },
      )
      .where(eq(drafts.postId, ref.postId))
      .run();
    const other = db
      .select({ mediaJson: postLocales.mediaJson })
      .from(postLocales)
      .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, locale === "en" ? "ru" : "en")))
      .get();
    db.update(postLocales)
      .set({ mediaJson: media == null ? (other?.mediaJson ?? []) : media, updatedAt: now })
      .where(and(eq(postLocales.postId, ref.postId), eq(postLocales.locale, locale)))
      .run();
  }
  updateSource(db, ref, { [locale === "en" ? "media_en" : "media"]: media }, now);
  enqueueRepairSiteJob(db, ref, media == null ? `use_other_media_for_${locale}` : `replace_${locale}_media`, now);
  return { ok: true, post_id: ref.postId, post_key: ref.postKey, locale, media: media != null };
}

/** Rebuilds one locale's public projection without touching social targets. */
export function refreshLocaleSiteTx(db: UnsafeBackendDb["db"], ref: ResolvedPublicationRef, locale: "ru" | "en"): Record<string, unknown> {
  const now = new Date().toISOString();
  enqueueRepairSiteJob(db, ref, `refresh_${locale}_site`, now);
  return { ok: true, post_id: ref.postId, post_key: ref.postKey, locale, site_refresh: true };
}

/** Media reaches Delivery either as a Content asset on disk or as a Telegram
 * file id; ingress converts file ids into assets, so requiring one here would
 * reject every item Studio itself produces. */
export function parseLocaleMedia(raw: string | undefined): Record<string, unknown>[] | null {
  if (!raw || ["none", "null", "ru", "fallback"].includes(raw.trim().toLowerCase())) return null;
  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!items || items.some((item) => !item || typeof item !== "object" || !locatesMedia(item as Record<string, unknown>)))
    throw new Error("each media item needs file_id, local_path or asset_id");
  return items as Record<string, unknown>[];
}

function locatesMedia(item: Record<string, unknown>): boolean {
  return ["file_id", "fileId", "local_path", "localPath", "path", "asset_id"].some((key) => item[key] != null);
}

/** Merges a patch into the durable publication source and the site's copy of
 * it. Both rows carry the same object, so writing one without the other is how
 * a repair reached the site and not the queue — or the reverse. */
export function updateSource(db: UnsafeBackendDb["db"], ref: ResolvedPublicationRef, patch: Record<string, unknown>, now: string): void {
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

function enqueueRepairSiteJob(db: UnsafeBackendDb["db"], ref: ResolvedPublicationRef, reason: string, now: string): void {
  const activeJob = db
    .select({ jobId: siteJobs.jobId })
    .from(siteJobs)
    .where(
      and(
        eq(siteJobs.messageId, ref.messageId),
        ref.postId == null ? isNull(siteJobs.postId) : eq(siteJobs.postId, ref.postId),
        eq(siteJobs.reason, reason),
        inArray(siteJobs.status, ["queued", "rendering"]),
      ),
    )
    .get();
  if (activeJob) return;

  db.insert(siteJobs)
    .values({ postId: ref.postId, messageId: ref.messageId, reason, status: "queued", nextAttemptAt: now, createdAt: now, updatedAt: now })
    .run();
}
