import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import * as z from "zod";
import { SITE_MEDIA_URL_PREFIX, siteMediaFilename, siteMediaPosterFilename } from "../content/site-media-naming.js";
import type { BackendDb } from "../db/client.js";
import { postLocales, postMetrics, posts, publications } from "../db/schema.js";

const siteMediaSchema = z
  .object({
    type: z.string().optional(),
    path: z.string().optional(),
    poster: z.string().optional(),
  })
  .passthrough();

export type SiteMedia = z.infer<typeof siteMediaSchema>;

const feedItemSchema = z
  .object({
    id: z.string(),
    post_id: z.number().int().positive(),
    message_id: z.number().int(),
    date: z.string(),
    text: z.string(),
    text_ru: z.string(),
    text_en: z.string(),
    html: z.string(),
    html_en: z.string(),
    slug_ru: z.string().nullable(),
    slug_en: z.string().nullable(),
    has_ru: z.boolean(),
    has_en: z.boolean(),
    media: z.array(siteMediaSchema),
    media_en: z.array(siteMediaSchema),
    image: z.string().nullable(),
    image_en: z.string().nullable(),
    audio_url_ru: z.string().nullable().optional(),
    audio_url_en: z.string().nullable().optional(),
    spotify_url_ru: z.string().nullable().optional(),
    spotify_url_en: z.string().nullable().optional(),
    views: z.number(),
  })
  .strict();

export type FeedItem = z.infer<typeof feedItemSchema>;

/** Published-site read model. It reads only stable publication data. */
export function loadPublicSiteFeed(backendDb: BackendDb): FeedItem[] {
  const ruLocale = alias(postLocales, "site_locale_ru");
  const enLocale = alias(postLocales, "site_locale_en");
  const rows = backendDb.db
    .select({
      postId: publications.postId,
      messageId: posts.messageId,
      postKey: posts.postKey,
      date: posts.dateUtc,
      createdAt: publications.createdAt,
      ruSlug: ruLocale.slug,
      ruText: ruLocale.text,
      ruHtml: ruLocale.html,
      ruMedia: ruLocale.mediaJson,
      ruEnabled: ruLocale.siteEnabled,
      ruPublishedAt: ruLocale.publishedAt,
      enSlug: enLocale.slug,
      enText: enLocale.text,
      enHtml: enLocale.html,
      enMedia: enLocale.mediaJson,
      enEnabled: enLocale.siteEnabled,
      enPublishedAt: enLocale.publishedAt,
      views: postMetrics.value,
    })
    .from(publications)
    .innerJoin(posts, eq(posts.postId, publications.postId))
    .leftJoin(ruLocale, and(eq(ruLocale.postId, publications.postId), eq(ruLocale.locale, "ru")))
    .leftJoin(enLocale, and(eq(enLocale.postId, publications.postId), eq(enLocale.locale, "en")))
    .leftJoin(
      postMetrics,
      and(eq(postMetrics.postKey, posts.postKey), eq(postMetrics.target, "telegram"), eq(postMetrics.metricName, "views")),
    )
    .where(inArray(publications.status, ["published", "failed"]))
    .orderBy(desc(posts.dateUtc), desc(publications.postId))
    .all();

  const now = Date.now();
  return rows.flatMap((row): FeedItem[] => {
    if (row.postId == null || row.messageId == null || row.postKey == null) return [];
    const ru = locale(
      row.ruEnabled,
      row.ruPublishedAt,
      row.ruText,
      row.ruSlug,
      row.ruHtml,
      publishedMedia(row.ruMedia, row.postId, "ru"),
      now,
    );
    const en = locale(
      row.enEnabled,
      row.enPublishedAt,
      row.enText,
      row.enSlug,
      row.enHtml,
      publishedMedia(row.enMedia, row.postId, "en"),
      now,
    );
    if (!ru.enabled && !en.enabled) return [];
    const media = ru.media;
    const mediaEn = en.media.length > 0 ? en.media : media;
    return [
      feedItemSchema.parse({
        id: row.postKey,
        post_id: row.postId,
        message_id: row.messageId,
        date: row.date ?? row.createdAt,
        text: ru.text,
        text_ru: ru.text,
        text_en: en.text,
        html: ru.html,
        html_en: en.html,
        slug_ru: ru.slug,
        slug_en: en.slug,
        has_ru: ru.enabled,
        has_en: en.enabled,
        media,
        media_en: mediaEn,
        image: firstImage(media),
        image_en: firstImage(mediaEn),
        views: row.views ?? 0,
      }),
    ];
  });
}

function locale(
  siteEnabled: number | null,
  publishedAt: string | null,
  text: string | null,
  slug: string | null,
  html: string | null,
  media: SiteMedia[] | null,
  now: number,
) {
  const published = publishedAt ? new Date(publishedAt).getTime() <= now : true;
  return { enabled: siteEnabled === 1 && published, text: text ?? "", slug, html: html ?? text ?? "", media: media ?? [] };
}

function firstImage(media: SiteMedia[]): string | null {
  return media.find((item) => item.type !== "video" && typeof item.path === "string")?.path ?? null;
}

/** Legacy rows stored before materialized media carried its own `path` fall back to
 * the naming convention `materializeSiteMedia` writes files under (see site-media-naming.ts).
 * This can only guess the jpg/mp4 default extension, not the true one a writer would have
 * detected from the source file. */
function publishedMedia(media: unknown, postId: number, locale: "ru" | "en"): SiteMedia[] {
  const items = z.array(siteMediaSchema).safeParse(media);
  return (items.success ? items.data : []).map((item, index) => {
    if (typeof item.path === "string" && item.path) return item;
    const type = String(item.type ?? "image").toLowerCase() === "video" ? "video" : "image";
    return {
      ...item,
      type,
      path: `${SITE_MEDIA_URL_PREFIX}/${siteMediaFilename(postId, locale, index, type === "video" ? "mp4" : "jpg")}`,
      ...(type === "video" ? { poster: `${SITE_MEDIA_URL_PREFIX}/${siteMediaPosterFilename(postId, locale, index)}` } : {}),
    };
  });
}
