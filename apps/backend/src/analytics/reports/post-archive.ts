import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { publicationRef } from "../../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { metricSamples, postLocales, posts, publications, videoTargets } from "../../db/schema.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { metricNumber } from "../snapshots/creator-store.js";

/** One page of an archive listing, shared by the post and video archives so a
 * screen that paginates one of them can do the arithmetic for both. */
export const ARCHIVE_PAGE_SIZE = 10;

/** One definition of "a post the creator actually published", shared by the
 * archive listing and the archive summary so the two can never disagree. */
function publishedPostCount(backendDb: BackendDb): number {
  const row = unsafeDb(backendDb)
    .db.select({ count: sql<number>`count(*)` })
    .from(posts)
    .innerJoin(publications, eq(publications.postId, posts.postId))
    .where(eq(publications.status, "published"))
    .get();
  return Number(row?.count ?? 0);
}

export function creatorPostArchive(
  backendDb: BackendDb,
  offset = 0,
  locale: StudioLocale = "en",
): { text: string; items: Array<{ id: number; label: string }>; total: number; pageSize: number } {
  const total = publishedPostCount(backendDb);
  const rows = unsafeDb(backendDb)
    .db.select({ id: posts.postId, label: sql<string>`coalesce(nullif(trim(${posts.text}), ''), 'Media post')` })
    .from(posts)
    .innerJoin(publications, eq(publications.postId, posts.postId))
    .where(eq(publications.status, "published"))
    .orderBy(desc(posts.updatedAt))
    .limit(ARCHIVE_PAGE_SIZE)
    .offset(offset)
    .all();
  const items = rows.flatMap((item) => (item.id == null ? [] : [{ id: item.id, label: item.label.replace(/\s+/g, " ").slice(0, 42) }]));
  return {
    text: items.length ? `📚 ${t(locale, "report.post-archive-choose")}` : `📚 ${t(locale, "report.no-posts")}`,
    items,
    total,
    pageSize: ARCHIVE_PAGE_SIZE,
  };
}

export function creatorPostMetrics(backendDb: BackendDb, postId: number, locale: StudioLocale = "en"): string {
  const publicationKey = publicationRef("post", postId);
  const post = unsafeDb(backendDb)
    .db.select({ text: posts.text, mediaCount: posts.mediaCount, dateMsk: posts.dateMsk })
    .from(posts)
    .where(eq(posts.postId, postId))
    .get();
  if (!post) return t(locale, "report.post-not-found");
  // Only the newest sample per (target, metric): metric_samples is an append-only
  // history, so a plain select would sum every past observation.
  const latestSampleIds = unsafeDb(backendDb)
    .db.select({ id: max(metricSamples.id) })
    .from(metricSamples)
    .where(eq(metricSamples.publicationKey, publicationKey))
    .groupBy(metricSamples.target, metricSamples.metricName);
  const rows = unsafeDb(backendDb)
    .db.select({ target: metricSamples.target, metricName: metricSamples.metricName, value: metricSamples.value })
    .from(metricSamples)
    .where(and(eq(metricSamples.publicationKey, publicationKey), inArray(metricSamples.id, latestSampleIds)))
    .orderBy(metricSamples.target, metricSamples.metricName)
    .all();
  const metrics = new Map<string, Record<string, number>>();
  for (const row of rows) metrics.set(row.target, { ...(metrics.get(row.target) ?? {}), [row.metricName]: metricNumber(row.value) });
  const totals = [...metrics.values()].reduce<{ views: number; interactions: number }>(
    (total, values) => ({
      views: total.views + (values.views ?? 0),
      interactions:
        total.interactions +
        (values.likes ?? 0) +
        (values.replies ?? 0) +
        (values.comments ?? 0) +
        (values.reposts ?? 0) +
        (values.shares ?? 0),
    }),
    { views: 0, interactions: 0 },
  );
  const lines = [
    `📝 *${t(locale, "post.heading", { id: postId })}*`,
    `👁 ${t(locale, "report.total-views")}: *${totals.views}*`,
    `💬 ${t(locale, "report.interactions")}: *${totals.interactions}*`,
    `🖼 ${t(locale, "post.media")}: *${post.mediaCount}*`,
    post.dateMsk ? `🗓 ${post.dateMsk}` : "",
    "",
    post.text?.slice(0, 600) || t(locale, "report.media-post"),
  ].filter(Boolean);
  for (const [target, values] of metrics)
    lines.push(
      `\n${target}: ${values.views ?? 0} ${t(locale, "report.views")} · ${(values.likes ?? 0) + (values.replies ?? 0) + (values.comments ?? 0)} ${t(locale, "report.interactions-lc")}`,
    );
  return lines.join("\n");
}

/** Published locale media is returned as data; the Telegram adapter decides how
 * to render it, so archive previews do not leak transport details into Analytics. */
export function creatorPostMedia(backendDb: BackendDb, postId: number, locale: StudioLocale): Record<string, unknown>[] {
  const preferred = locale === "ru" ? "ru" : "en";
  const row = unsafeDb(backendDb)
    .db.select({ mediaJson: postLocales.mediaJson })
    .from(postLocales)
    .where(and(eq(postLocales.postId, postId), eq(postLocales.locale, preferred)))
    .get();
  const media = row?.mediaJson;
  return Array.isArray(media) ? media.filter((item): item is Record<string, unknown> => item != null && typeof item === "object") : [];
}

export function creatorArchiveSummary(
  backendDb: BackendDb,
  locale: StudioLocale = "en",
): {
  text: string;
  posts: number;
  videos: number;
} {
  const postCount = publishedPostCount(backendDb);
  const videos = Number(
    unsafeDb(backendDb)
      .db.select({ count: sql<number>`count(distinct ${videoTargets.videoDraftId})` })
      .from(videoTargets)
      .where(eq(videoTargets.status, "published"))
      .get()?.count ?? 0,
  );
  return {
    text: [
      `📚 *${t(locale, "report.archive-title")}*`,
      "",
      t(locale, "report.archive-desc"),
      `${t(locale, "report.posts")}: *${postCount}*`,
      `${t(locale, "report.videos")}: *${videos}*`,
    ].join("\n"),
    posts: postCount,
    videos,
  };
}
