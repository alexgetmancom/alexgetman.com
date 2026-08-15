import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { postLocales, publicationSources, publications, siteJobs } from "../src/db/schema.js";
import { materializeSitePosts, recoverStaleSiteJobs, runSiteJobCycle } from "../src/delivery/site-jobs.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;
let tempDir: string | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("site jobs", () => {
  it("ends stale lock recovery when the retry budget is exhausted", () => {
    backendDb = openBackendDb(":memory:");
    const lockedAt = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    backendDb.db
      .insert(siteJobs)
      .values({
        messageId: 11,
        reason: "publish",
        status: "rendering",
        attemptCount: 4,
        lockedBy: "dead-worker",
        lockedAt,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(recoverStaleSiteJobs(backendDb, 1)).toBe(1);
    expect(backendDb.db.select().from(siteJobs).get()).toMatchObject({
      status: "failed",
      attemptCount: 5,
      nextAttemptAt: null,
      lockedBy: null,
      lockedAt: null,
      lastError: "stale site lock recovered",
    });
  });

  it("persists materialized media in the public read model", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ SITE_PUBLIC_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    backendDb.db.insert(publications).values({ postId: 1, status: "published", createdAt: now, updatedAt: now }).run();
    backendDb.db.insert(postLocales).values({ postId: 1, locale: "ru", slug: "ru", siteEnabled: 1, updatedAt: now }).run();
    backendDb.db.insert(postLocales).values({ postId: 1, locale: "en", slug: "en", siteEnabled: 1, updatedAt: now }).run();
    backendDb.db
      .insert(publicationSources)
      .values({
        postId: 1,
        itemJson: {
          id: "post:1",
          post_id: 1,
          message_id: 11,
          date: now,
          text: "RU",
          text_ru: "RU",
          text_en: "EN",
          has_ru: true,
          has_en: true,
          slug_ru: "ru",
          slug_en: "en",
        },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await materializeSitePosts(config, backendDb);
    expect(backendDb.db.select({ locale: postLocales.locale, media: postLocales.mediaJson }).from(postLocales).all()).toEqual([
      { locale: "ru", media: [] },
      { locale: "en", media: [] },
    ]);
  });

  it("claims and completes queued site jobs", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ SITE_PUBLIC_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    backendDb.db
      .insert(siteJobs)
      .values({ postId: 1, messageId: 11, reason: "publish", status: "queued", createdAt: now, updatedAt: now })
      .run();

    expect(await runSiteJobCycle(config, backendDb)).toBe(1);
    const job = backendDb.db.select({ status: siteJobs.status }).from(siteJobs).get();
    if (!job) throw new Error("expected site job");
    expect(job.status).toBe("published");
  });

  it("publishes the EN site job while a later RU site job remains queued", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ SITE_PUBLIC_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date(Date.now() - 1_000).toISOString();
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    backendDb.db
      .insert(publicationSources)
      .values({
        postId: 7,
        itemJson: {
          post_id: 7,
          text_ru: "RU",
          text_en: "EN",
          has_ru: true,
          has_en: true,
          publish_at_ru: later,
          publish_at_en: now,
          slug_ru: "ru",
          slug_en: "en",
        },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    backendDb.db
      .insert(siteJobs)
      .values([
        { postId: 7, messageId: 7, reason: "site_en", status: "queued", nextAttemptAt: now, createdAt: now, updatedAt: now },
        { postId: 7, messageId: 7, reason: "site_ru", status: "queued", nextAttemptAt: later, createdAt: now, updatedAt: now },
      ])
      .run();

    expect(await runSiteJobCycle(config, backendDb)).toBe(1);
    expect(backendDb.db.select({ reason: siteJobs.reason, status: siteJobs.status }).from(siteJobs).orderBy(siteJobs.reason).all()).toEqual(
      [
        { reason: "site_en", status: "published" },
        { reason: "site_ru", status: "queued" },
      ],
    );
  });

  it("does not re-materialize a locale after its site target was cancelled", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ SITE_PUBLIC_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    backendDb.db
      .insert(publicationSources)
      .values({
        postId: 7,
        itemJson: { post_id: 7, text_ru: "RU", text_en: "EN", has_ru: true, has_en: true, publish_at_ru: now, publish_at_en: now },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    backendDb.db
      .insert(postLocales)
      .values([
        { postId: 7, locale: "ru", slug: "ru", mediaJson: [{ type: "image", path: "keep.jpg" }], siteEnabled: 1, updatedAt: now },
        { postId: 7, locale: "en", slug: "en", siteEnabled: 1, updatedAt: now },
      ])
      .run();
    backendDb.db
      .insert(siteJobs)
      .values({
        postId: 7,
        messageId: 7,
        reason: "site_ru",
        status: "cancelled",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    backendDb.db
      .insert(siteJobs)
      .values({
        postId: 7,
        messageId: 7,
        reason: "site_en",
        status: "published",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await materializeSitePosts(config, backendDb);
    expect(backendDb.db.select({ locale: postLocales.locale, media: postLocales.mediaJson }).from(postLocales).all()).toEqual([
      { locale: "ru", media: [{ type: "image", path: "keep.jpg" }] },
      { locale: "en", media: [] },
    ]);
  });

  it("fails only the publication that could not render, not the batch it was claimed with", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadTestConfig({ SITE_PUBLIC_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    for (const postId of [1, 2]) {
      backendDb.db.insert(publications).values({ postId, status: "published", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(postLocales)
        .values({ postId, locale: "ru", slug: `ru-${postId}`, siteEnabled: 1, updatedAt: now })
        .run();
      backendDb.db
        .insert(publicationSources)
        .values({
          postId,
          itemJson: {
            id: `post:${postId}`,
            post_id: postId,
            message_id: postId,
            date: now,
            text: "RU",
            text_ru: "RU",
            has_ru: true,
            slug_ru: `ru-${postId}`,
            // Post 2 points at an image no one can fetch. It used to reject the
            // one Promise.all that carried both, and the cycle then spent an
            // attempt on post 1 too — five cycles and both were `failed`.
            ...(postId === 2 ? { media: [{ type: "photo", url: "https://media.invalid/gone.jpg" }] } : {}),
          },
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({ postId, messageId: postId, reason: "site_ru", status: "queued", createdAt: now, updatedAt: now })
        .run();
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("media host is unreachable"))) as unknown as typeof fetch;
    try {
      await runSiteJobCycle(config, backendDb);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(
      backendDb.db.select({ postId: siteJobs.postId, status: siteJobs.status, attemptCount: siteJobs.attemptCount }).from(siteJobs).all(),
    ).toEqual([
      { postId: 1, status: "published", attemptCount: 0 },
      { postId: 2, status: "queued", attemptCount: 1 },
    ]);
  });
});
