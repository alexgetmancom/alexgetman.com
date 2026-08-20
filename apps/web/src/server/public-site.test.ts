import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type BackendDb, openBackendDb, unsafeDb } from "../../../backend/src/db/client.js";
import { knowledgeEntities, postEntityLinks, postLocales, postMetrics, posts, publications } from "../../../backend/src/db/schema.js";
import { loadPublicSiteFeed, loadPublicSiteItem } from "../../../backend/src/public/site-read-model.js";

let backendDb: BackendDb;
let rawDb: ReturnType<typeof unsafeDb>;

// Opened per test rather than inside each `it`: a failure before the assignment
// used to leave the previous test's handle in place and close it twice.
beforeEach(() => {
  backendDb = openBackendDb(":memory:");
  rawDb = unsafeDb(backendDb);
});
afterEach(() => backendDb.close());

describe("Drizzle site feed", () => {
  it("reads published localized posts and Telegram views from SQLite without feed.json", () => {
    const now = new Date().toISOString();
    rawDb.db.insert(publications).values({ postId: 7, status: "published", createdAt: now, updatedAt: now }).run();
    rawDb.db
      .insert(posts)
      .values({
        publicationKey: "post:7",
        postId: 7,
        source: "bot",
        channel: "controller",
        messageId: 77,
        dateUtc: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    rawDb.db
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
    rawDb.db
      .insert(postMetrics)
      .values({ publicationKey: "post:7", target: "telegram", metricName: "views", value: 321, unit: "count" })
      .run();
    const entity = rawDb.db
      .insert(knowledgeEntities)
      .values({ kind: "company", slug: "example-ai", titleRu: "Example AI", titleEn: "Example AI", createdAt: now, updatedAt: now })
      .returning({ id: knowledgeEntities.id })
      .get();
    if (!entity) throw new Error("knowledge entity was not inserted");
    rawDb.db.insert(postEntityLinks).values({ postId: 7, entityId: entity.id, createdAt: now }).run();

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
        entities: [expect.objectContaining({ kind: "company", slug: "example-ai" })],
      }),
    ]);
    expect(loadPublicSiteItem(backendDb, 7)).toEqual(expect.objectContaining({ id: "post:7", post_id: 7, text_en: "English text" }));
    expect(loadPublicSiteItem(backendDb, 999)).toBeUndefined();
  });

  it("does not expose scheduled or disabled locales", () => {
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    rawDb.db.insert(publications).values({ postId: 8, status: "scheduled", createdAt: now, updatedAt: now }).run();
    rawDb.db
      .insert(posts)
      .values({ publicationKey: "post:8", postId: 8, source: "bot", channel: "controller", messageId: 88, createdAt: now, updatedAt: now })
      .run();
    rawDb.db
      .insert(postLocales)
      .values({
        postId: 8,
        locale: "en",
        slug: "future",
        text: "Future",
        mediaJson: [],
        siteEnabled: 1,
        publishedAt: future,
        updatedAt: now,
      })
      .run();
    expect(loadPublicSiteFeed(backendDb)).toEqual([]);
  });

  it("exposes an EN locale while RU remains scheduled", () => {
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    rawDb.db.insert(publications).values({ postId: 10, status: "scheduled", createdAt: now, updatedAt: now }).run();
    rawDb.db
      .insert(posts)
      .values({
        publicationKey: "post:10",
        postId: 10,
        source: "studio",
        channel: "studio",
        messageId: 110,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    rawDb.db
      .insert(postLocales)
      .values([
        {
          postId: 10,
          locale: "ru",
          slug: "ru-future",
          text: "RU future",
          mediaJson: [],
          siteEnabled: 1,
          publishedAt: future,
          updatedAt: now,
        },
        { postId: 10, locale: "en", slug: "en-now", text: "EN now", mediaJson: [], siteEnabled: 1, publishedAt: now, updatedAt: now },
      ])
      .run();

    expect(loadPublicSiteItem(backendDb, 10)).toEqual(
      expect.objectContaining({ text_en: "EN now", has_en: true, has_ru: false, slug_en: "en-now" }),
    );
  });

  it("reads the persisted site media manifest", () => {
    const now = new Date().toISOString();
    rawDb.db.insert(publications).values({ postId: 9, status: "published", createdAt: now, updatedAt: now }).run();
    rawDb.db
      .insert(posts)
      .values({ publicationKey: "post:9", postId: 9, source: "bot", channel: "controller", messageId: 99, createdAt: now, updatedAt: now })
      .run();
    rawDb.db
      .insert(postLocales)
      .values({
        postId: 9,
        locale: "en",
        slug: "media-post",
        text: "Media post",
        mediaJson: [{ type: "image", path: "media/posts/9-en-0-vertical.jpg?v=1234" }],
        siteEnabled: 1,
        publishedAt: now,
        updatedAt: now,
      })
      .run();

    expect(loadPublicSiteFeed(backendDb)[0]).toEqual(
      expect.objectContaining({
        image_en: "media/posts/9-en-0-vertical.jpg?v=1234",
        media_en: [expect.objectContaining({ path: "media/posts/9-en-0-vertical.jpg?v=1234" })],
      }),
    );
  });
});
