import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BackendDb } from "../../../backend/src/db/client.js";
import { postLocales, postMetrics, posts, publications } from "../../../backend/src/db/schema.js";
import { getRuntime } from "../server/runtime.js";

type SiteMedia = { type?: string; path?: string; poster?: string; [key: string]: unknown };

type FeedItem = {
  id: string;
  post_id: number;
  message_id: number;
  date: string;
  text: string;
  text_ru: string;
  text_en: string;
  html: string;
  html_en: string;
  slug_ru: string | null;
  slug_en: string | null;
  has_ru: boolean;
  has_en: boolean;
  media: SiteMedia[];
  media_en: SiteMedia[];
  image: string | null;
  image_en: string | null;
  views: number;
};

export function loadFeedItems(backendDb: BackendDb = getRuntime().backendDb): FeedItem[] {
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
    .where(eq(publications.status, "published"))
    .orderBy(desc(posts.dateUtc), desc(publications.postId))
    .all();

  const now = Date.now();
  return rows.flatMap((row): FeedItem[] => {
    if (row.postId == null || row.messageId == null || row.postKey == null) return [];
    const ru = locale(row.ruEnabled, row.ruPublishedAt, row.ruText, row.ruSlug, row.ruHtml, row.ruMedia as SiteMedia[] | null, now);
    const en = locale(row.enEnabled, row.enPublishedAt, row.enText, row.enSlug, row.enHtml, row.enMedia as SiteMedia[] | null, now);
    if (!ru.enabled && !en.enabled) return [];
    const media = ru.media;
    const mediaEn = en.media.length > 0 ? en.media : media;
    return [
      {
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
      },
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
