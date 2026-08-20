import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import * as z from "zod";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { knowledgeEntities, postEntityLinks, postLocales, postMetrics, posts, publications } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";

const siteMediaSchema = z
  .object({
    type: z.string().optional(),
    path: z.string().min(1),
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

/** The whole published site, indexed the way the routes actually ask for it. */
type PublicSiteSnapshot = {
  items: FeedItem[];
  byPostId: Map<number, FeedItem>;
};

/** Rebuilding the feed costs five queries plus a Zod parse per post, and a
 * single page render asks for it more than once (a post page needs the item and
 * the surrounding feed). Twenty-six routes share one build instead.
 *
 * The TTL is what makes this safe without a change feed. A publish from the
 * ops CLI happens in a separate `docker exec` process, so no in-process hook
 * can see it, and `publishedAt` gating means an untouched database still turns
 * a scheduled post visible on its own. Both are bounded by the TTL. */
const FEED_CACHE_TTL_MS = 3_000;

type CachedFeed = { snapshot: PublicSiteSnapshot; builtAt: number };
// Keyed by the database handle so a test's `:memory:` database and the closed
// handle of a previous runtime never hand their feed to anyone else.
const feedCache = new WeakMap<BackendDb, CachedFeed>();

/** Published-site read model. It reads only stable publication data. */
export function loadPublicSiteFeed(backendDb: BackendDb): FeedItem[] {
  return loadPublicSiteSnapshot(backendDb).items;
}

/** Loads one published item without building the surrounding archive. */
export function loadPublicSiteItem(backendDb: BackendDb, postId: number): FeedItem | undefined {
  return buildPublicSiteFeed(backendDb, postId)[0];
}

function loadPublicSiteSnapshot(backendDb: BackendDb): PublicSiteSnapshot {
  const cached = feedCache.get(backendDb);
  if (cached && Date.now() - cached.builtAt < FEED_CACHE_TTL_MS) return cached.snapshot;
  const items = buildPublicSiteFeed(backendDb);
  const snapshot: PublicSiteSnapshot = { items, byPostId: new Map(items.map((item) => [item.post_id, item])) };
  feedCache.set(backendDb, { snapshot, builtAt: Date.now() });
  return snapshot;
}

/** Drops the cached feed so the next read rebuilds it. Call this from anything
 * in this process that just changed what the site publishes; the TTL is only
 * the fallback for changes made elsewhere. */
export function invalidatePublicSiteFeed(backendDb: BackendDb): void {
  feedCache.delete(backendDb);
}

function buildPublicSiteFeed(backendDb: BackendDb, postId?: number): FeedItem[] {
  const ruLocale = alias(postLocales, "site_locale_ru");
  const enLocale = alias(postLocales, "site_locale_en");
  const rows = unsafeDb(backendDb)
    .db.select({
      postId: publications.postId,
      messageId: posts.messageId,
      publicationKey: posts.publicationKey,
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
      and(eq(postMetrics.publicationKey, posts.publicationKey), eq(postMetrics.target, "telegram"), eq(postMetrics.metricName, "views")),
    )
    .where(
      postId === undefined
        ? inArray(publications.status, ["published", "failed", "scheduled"])
        : and(inArray(publications.status, ["published", "failed", "scheduled"]), eq(publications.postId, postId)),
    )
    .orderBy(desc(posts.dateUtc), desc(publications.postId))
    .all();

  const postIds = rows.flatMap((row) => (row.postId == null ? [] : [row.postId]));
  const entitiesByPost = new Map<number, FeedEntity[]>();
  if (postIds.length > 0) {
    const entityRows = unsafeDb(backendDb)
      .db.select({
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
    if (row.postId == null || row.messageId == null || row.publicationKey == null) return [];
    const ru = locale(row.ruEnabled, row.ruPublishedAt, row.ruText, row.ruSlug, row.ruHtml, publishedMedia(row.ruMedia), now);
    const en = locale(row.enEnabled, row.enPublishedAt, row.enText, row.enSlug, row.enHtml, publishedMedia(row.enMedia), now);
    if (!ru.enabled && !en.enabled) return [];
    const media = ru.media;
    const mediaEn = en.media.length > 0 ? en.media : media;
    const parsed = feedItemSchema.safeParse({
      id: row.publicationKey,
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
      entities: entitiesByPost.get(row.postId) ?? [],
      views: row.views ?? 0,
    });
    // A single malformed row (a legacy shape, an unexpected null) must never take
    // down the whole public feed; drop it and keep every other post serving.
    if (!parsed.success) {
      recordDomainEvent(backendDb.events, {
        ref: publicationRef("post", row.postId),
        type: "site.feed.item_invalid",
        severity: "warn",
        message: `Post ${row.publicationKey} dropped from the public feed: ${parsed.error.issues[0]?.message ?? "invalid shape"}`,
        details: { publication_key: row.publicationKey, issues: parsed.error.issues.slice(0, 5) },
        cooldownSeconds: 60 * 60,
      });
      return [];
    }
    return [parsed.data];
  });
}

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

function publishedMedia(media: unknown): SiteMedia[] {
  const items = z.array(siteMediaSchema).safeParse(media);
  return items.success ? items.data : [];
}
