import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationSources, publications, siteJobs } from "../src/db/schema.js";
import { renderFeedFiles, runSiteJobCycle } from "../src/delivery/site-jobs.js";
import { loadConfig } from "../src/foundation/config.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: UnsafeBackendDb | null = null;
let tempDir: string | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("site jobs", () => {
  it("renders feed and metrics JSON from publication sources", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const feedJson = path.join(tempDir, "feed.json");
    const metricsJson = path.join(tempDir, "content-metrics.json");
    const config = loadConfig({ FEED_JSON: feedJson, SITE_CONTENT_METRICS_JSON: metricsJson, SITE_PUBLIC_DIR: tempDir });
    backendDb = openBackendDb(":memory:");
    const now = new Date().toISOString();
    backendDb.db.insert(publications).values({ postId: 1, status: "published", createdAt: now, updatedAt: now }).run();
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

    await renderFeedFiles(config, backendDb);

    const feed = JSON.parse(fs.readFileSync(feedJson, "utf8")) as Record<string, unknown>;
    const metrics = JSON.parse(fs.readFileSync(metricsJson, "utf8")) as Record<string, unknown>;
    expect(feed).toMatchObject({ channel: "alexgetmancom" });
    expect(feed.items as unknown[]).toHaveLength(1);
    expect(metrics.posts).toBe(1);
  });

  it("claims and completes queued site jobs", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-site-"));
    const config = loadConfig({
      FEED_JSON: path.join(tempDir, "feed.json"),
      SITE_CONTENT_METRICS_JSON: path.join(tempDir, "content-metrics.json"),
      SITE_PUBLIC_DIR: tempDir,
    });
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
    const config = loadConfig({
      FEED_JSON: path.join(tempDir, "feed.json"),
      SITE_CONTENT_METRICS_JSON: path.join(tempDir, "content-metrics.json"),
      SITE_PUBLIC_DIR: tempDir,
    });
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
    const config = loadConfig({
      FEED_JSON: path.join(tempDir, "feed.json"),
      SITE_CONTENT_METRICS_JSON: path.join(tempDir, "content-metrics.json"),
      SITE_PUBLIC_DIR: tempDir,
    });
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

    await renderFeedFiles(config, backendDb);

    const feed = JSON.parse(fs.readFileSync(config.FEED_JSON, "utf8")) as { items: Array<Record<string, unknown>> };
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ has_ru: false, has_en: true });
  });
});
