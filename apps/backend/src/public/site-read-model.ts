import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import * as z from "zod";
import {
  SITE_MEDIA_URL_PREFIX,
  siteMediaFilename,
  siteMediaPosterFilename,
  siteMediaVerticalFilename,
} from "../content/site-media-naming.js";
import type { BackendDb } from "../db/client.js";
import { knowledgeEntities, postEntityLinks, postLocales, postMetrics, postSources, posts, publications } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";

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
    sources: z.array(
      z.object({
        url: z.string().url(),
        label_ru: z.string(),
        label_en: z.string().nullable(),
        display_kind: z.enum(["official", "opinion"]).nullable(),
        published_at: z.string().nullable(),
      }),
    ),
    entities: z.array(
      z.object({
        kind: z.enum(["company", "model", "person", "product", "topic"]),
        slug: z.string(),
        title_ru: z.string(),
        title_en: z.string().nullable(),
        link_role: z.enum(["focus", "mention"]),
      }),
    ),
    views: z.number(),
  })
  .strict();

export type FeedItem = z.infer<typeof feedItemSchema>;

/** Published-site read model. It reads only stable publication data. */
export function loadPublicSiteFeed(backendDb: BackendDb, sitePublicDir = process.env.SITE_PUBLIC_DIR ?? "/data/site"): FeedItem[] {
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

  const postIds = rows.flatMap((row) => (row.postId == null ? [] : [row.postId]));
  const sourcesByPost = new Map<number, FeedSource[]>();
  const entitiesByPost = new Map<number, FeedEntity[]>();
  if (postIds.length > 0) {
    const sourceRows = backendDb.db
      .select({
        postId: postSources.postId,
        url: postSources.url,
        labelRu: postSources.labelRu,
        labelEn: postSources.labelEn,
        displayKind: postSources.displayKind,
        publishedAt: postSources.publishedAt,
      })
      .from(postSources)
      .where(inArray(postSources.postId, postIds))
      .orderBy(asc(postSources.postId), asc(postSources.sortOrder), asc(postSources.id))
      .all();
    for (const source of sourceRows) {
      const list = sourcesByPost.get(source.postId) ?? [];
      list.push({
        url: source.url,
        label_ru: source.labelRu,
        label_en: source.labelEn,
        display_kind: source.displayKind === "official" || source.displayKind === "opinion" ? source.displayKind : null,
        published_at: source.publishedAt,
      });
      sourcesByPost.set(source.postId, list);
    }
    const entityRows = backendDb.db
      .select({
        postId: postEntityLinks.postId,
        kind: knowledgeEntities.kind,
        slug: knowledgeEntities.slug,
        titleRu: knowledgeEntities.titleRu,
        titleEn: knowledgeEntities.titleEn,
        linkRole: postEntityLinks.linkRole,
      })
      .from(postEntityLinks)
      .innerJoin(knowledgeEntities, eq(knowledgeEntities.id, postEntityLinks.entityId))
      .where(inArray(postEntityLinks.postId, postIds))
      .orderBy(asc(postEntityLinks.postId), asc(knowledgeEntities.kind), asc(knowledgeEntities.titleRu))
      .all();
    for (const entity of entityRows) {
      if (!isEntityKind(entity.kind)) continue;
      const list = entitiesByPost.get(entity.postId) ?? [];
      list.push({
        kind: entity.kind,
        slug: entity.slug,
        title_ru: entity.titleRu,
        title_en: entity.titleEn,
        link_role: entity.linkRole === "focus" ? "focus" : "mention",
      });
      entitiesByPost.set(entity.postId, list);
    }
  }
  const now = Date.now();
  return rows.flatMap((row): FeedItem[] => {
    if (row.postId == null || row.messageId == null || row.postKey == null) return [];
    const ru = locale(
      row.ruEnabled,
      row.ruPublishedAt,
      row.ruText,
      row.ruSlug,
      row.ruHtml,
      publishedMedia(row.ruMedia, row.postId, "ru", sitePublicDir),
      now,
    );
    const en = locale(
      row.enEnabled,
      row.enPublishedAt,
      row.enText,
      row.enSlug,
      row.enHtml,
      publishedMedia(row.enMedia, row.postId, "en", sitePublicDir),
      now,
    );
    if (!ru.enabled && !en.enabled) return [];
    const media = ru.media;
    const mediaEn = en.media.length > 0 ? en.media : media;
    const parsed = feedItemSchema.safeParse({
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
      sources: sourcesByPost.get(row.postId) ?? [],
      entities: entitiesByPost.get(row.postId) ?? [],
      views: row.views ?? 0,
    });
    // A single malformed row (a legacy shape, an unexpected null) must never take
    // down the whole public feed; drop it and keep every other post serving.
    if (!parsed.success) {
      recordDomainEvent(backendDb, {
        ref: row.postKey,
        type: "site.feed.item_invalid",
        severity: "warn",
        message: `Post ${row.postKey} dropped from the public feed: ${parsed.error.issues[0]?.message ?? "invalid shape"}`,
        details: { post_key: row.postKey, issues: parsed.error.issues.slice(0, 5) },
        cooldownSeconds: 60 * 60,
      });
      return [];
    }
    return [parsed.data];
  });
}

type FeedSource = {
  url: string;
  label_ru: string;
  label_en: string | null;
  display_kind: "official" | "opinion" | null;
  published_at: string | null;
};

type FeedEntity = {
  kind: "company" | "model" | "person" | "product" | "topic";
  slug: string;
  title_ru: string;
  title_en: string | null;
  link_role: "focus" | "mention";
};

function isEntityKind(value: string): value is FeedEntity["kind"] {
  return value === "company" || value === "model" || value === "person" || value === "product" || value === "topic";
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

/** Once a composite exists it is never deleted, so a positive result is safe to
 * remember for the life of the process; only "not yet backfilled" is re-checked
 * on every call, so a completed backfill is still picked up without a restart. */
const verticalMediaExistsCache = new Map<string, boolean>();
function verticalMediaExists(fullPath: string): boolean {
  if (verticalMediaExistsCache.get(fullPath)) return true;
  const exists = fs.existsSync(fullPath);
  if (exists) verticalMediaExistsCache.set(fullPath, true);
  return exists;
}

/** The final viewer URL is chosen only after its durable file exists. This is
 * deliberate: the archive is backfilled asynchronously on VM-106, and a
 * missing composite must never make an older card disappear. */
function publishedMedia(media: unknown, postId: number, locale: "ru" | "en", sitePublicDir: string): SiteMedia[] {
  const items = z.array(siteMediaSchema).safeParse(media);
  return (items.success ? items.data : []).map((item, index) => {
    if (typeof item.path === "string" && item.path) return item;
    const type = String(item.type ?? "image").toLowerCase() === "video" ? "video" : "image";
    const vertical = siteMediaVerticalFilename(postId, locale, index, type);
    const original = siteMediaFilename(postId, locale, index, type === "video" ? "mp4" : "jpg");
    const viewerPath = verticalMediaExists(path.join(sitePublicDir, SITE_MEDIA_URL_PREFIX, vertical)) ? vertical : original;
    return {
      ...item,
      type,
      path: `${SITE_MEDIA_URL_PREFIX}/${viewerPath}`,
      ...(type === "video" ? { poster: `${SITE_MEDIA_URL_PREFIX}/${siteMediaPosterFilename(postId, locale, index)}` } : {}),
    };
  });
}
