import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { loadPublicSiteFeed, loadPublicSiteItem } from "../../../backend/src/public/site-read-model.js";

let backendDb: BackendDb;

// Opened per test rather than inside each `it`: a failure before the assignment
// used to leave the previous test's handle in place and close it twice.
beforeEach(() => {
  backendDb = openBackendDb(":memory:");
});
afterEach(() => backendDb.close());

describe("Drizzle site feed", () => {
  it("reads published localized posts and Telegram views from SQLite without feed.json", () => {
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
    expect(loadPublicSiteItem(backendDb, 7)).toEqual(expect.objectContaining({ id: "post:7", post_id: 7, text_en: "English text" }));
    expect(loadPublicSiteItem(backendDb, 999)).toBeUndefined();
  });

  it("does not expose scheduled or disabled locales", () => {
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

    const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-read-model-"));
    try {
      const vertical = path.join(siteDir, "media/posts/9-en-0-vertical.jpg");
      fs.mkdirSync(path.dirname(vertical), { recursive: true });
      fs.writeFileSync(vertical, "ready");
      expect(loadPublicSiteFeed(backendDb, siteDir)[0]).toEqual(
        expect.objectContaining({
          image_en: expect.stringMatching(/^media\/posts\/9-en-0-vertical\.jpg\?v=[a-f0-9]{12}$/),
          media_en: [expect.objectContaining({ path: expect.stringMatching(/^media\/posts\/9-en-0-vertical\.jpg\?v=[a-f0-9]{12}$/) })],
        }),
      );
      expect(loadPublicSiteFeed(backendDb, path.join(siteDir, "not-ready"))[0]).toEqual(
        expect.objectContaining({ image_en: "media/posts/9-en-0.jpg" }),
      );
    } finally {
      fs.rmSync(siteDir, { recursive: true, force: true });
    }
  });
});
