import { afterEach, describe, expect, it } from "bun:test";
import { type BackendDb, openBackendDb } from "../../../backend/src/db/client.js";
import {
  knowledgeEntities,
  postEntityLinks,
  postLocales,
  postMetrics,
  postSources,
  posts,
  publications,
} from "../../../backend/src/db/schema.js";
import { loadPublicSiteFeed } from "../../../backend/src/public/site-read-model.js";

let backendDb: BackendDb | undefined;

afterEach(() => backendDb?.close());

describe("Drizzle site feed", () => {
  it("reads published localized posts and Telegram views from SQLite without feed.json", () => {
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    backendDb.db.insert(publications).values({ postId: 7, status: "published", createdAt: now, updatedAt: now }).run();
    backendDb.db
      .insert(posts)
      .values({
        postKey: "post:7",
        postId: 7,
        source: "bot",
        channel: "controller",
        messageId: 77,
        dateUtc: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    backendDb.db
      .insert(postLocales)
      .values([
        {
          postId: 7,
          locale: "ru",
          slug: "russkiy-post",
          text: "Русский текст",
          html: "<p>Русский текст</p>",
          mediaJson: [{ type: "image", path: "media/posts/7-ru.jpg" }],
          siteEnabled: 1,
          publishedAt: now,
          updatedAt: now,
        },
        {
          postId: 7,
          locale: "en",
          slug: "english-post",
          text: "English text",
          html: "<p>English text</p>",
          mediaJson: [{ type: "video", path: "media/posts/7-en.mp4", poster: "media/posts/7-en.jpg" }],
          siteEnabled: 1,
          publishedAt: now,
          updatedAt: now,
        },
      ])
      .run();
    backendDb.db
      .insert(postMetrics)
      .values({ postKey: "post:7", target: "telegram", metricName: "views", value: 321, unit: "count" })
      .run();
    backendDb.db
      .insert(postSources)
      .values({
        postId: 7,
        url: "https://example.com/announcement",
        labelRu: "Официальный анонс",
        labelEn: "Official announcement",
        displayKind: "official",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const entity = backendDb.db
      .insert(knowledgeEntities)
      .values({ kind: "company", slug: "example-ai", titleRu: "Example AI", titleEn: "Example AI", createdAt: now, updatedAt: now })
      .returning({ id: knowledgeEntities.id })
      .get();
    if (!entity) throw new Error("knowledge entity was not inserted");
    backendDb.db.insert(postEntityLinks).values({ postId: 7, entityId: entity.id, createdAt: now }).run();

    expect(loadPublicSiteFeed(backendDb)).toEqual([
      expect.objectContaining({
        id: "post:7",
        post_id: 7,
        text: "Русский текст",
        text_en: "English text",
        slug_ru: "russkiy-post",
        slug_en: "english-post",
        image: "media/posts/7-ru.jpg",
        image_en: null,
        views: 321,
        sources: [expect.objectContaining({ url: "https://example.com/announcement", display_kind: "official" })],
        entities: [expect.objectContaining({ kind: "company", slug: "example-ai" })],
      }),
    ]);
  });

  it("does not expose scheduled or disabled locales", () => {
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    backendDb.db.insert(publications).values({ postId: 8, status: "scheduled", createdAt: now, updatedAt: now }).run();
    backendDb.db
      .insert(posts)
      .values({ postKey: "post:8", postId: 8, source: "bot", channel: "controller", messageId: 88, createdAt: now, updatedAt: now })
      .run();
    backendDb.db
      .insert(postLocales)
      .values({ postId: 8, locale: "en", slug: "future", text: "Future", mediaJson: [], siteEnabled: 1, publishedAt: now, updatedAt: now })
      .run();
    expect(loadPublicSiteFeed(backendDb)).toEqual([]);
  });

  it("maps published Telegram media IDs to the deterministic site media manifest", () => {
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    backendDb.db.insert(publications).values({ postId: 9, status: "published", createdAt: now, updatedAt: now }).run();
    backendDb.db
      .insert(posts)
      .values({ postKey: "post:9", postId: 9, source: "bot", channel: "controller", messageId: 99, createdAt: now, updatedAt: now })
      .run();
    backendDb.db
      .insert(postLocales)
      .values({
        postId: 9,
        locale: "en",
        slug: "media-post",
        text: "Media post",
        mediaJson: [{ type: "photo", file_id: "telegram-file" }],
        siteEnabled: 1,
        publishedAt: now,
        updatedAt: now,
      })
      .run();

    expect(loadPublicSiteFeed(backendDb)[0]).toEqual(
      expect.objectContaining({
        image_en: "media/posts/9-en-0.jpg",
        media_en: [expect.objectContaining({ path: "media/posts/9-en-0.jpg" })],
      }),
    );
  });
});
