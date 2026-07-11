import { afterEach, describe, expect, it } from "bun:test";
import { type BackendDb, openBackendDb } from "../../../backend/src/db/client.js";
import { postLocales, postMetrics, posts, publications } from "../../../backend/src/db/schema.js";
import { loadFeedItems } from "./feed.js";

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

    expect(loadFeedItems(backendDb)).toEqual([
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
    expect(loadFeedItems(backendDb)).toEqual([]);
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

    expect(loadFeedItems(backendDb)[0]).toEqual(
      expect.objectContaining({
        image_en: "media/posts/9-en-0.jpg",
        media_en: [expect.objectContaining({ path: "media/posts/9-en-0.jpg" })],
      }),
    );
  });
});
