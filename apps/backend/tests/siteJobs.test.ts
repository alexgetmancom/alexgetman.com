import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { type BackendDb, openBackendDb } from "../src/db/client.js";
import { publicationSources, publications, siteJobs } from "../src/db/schema.js";
import { renderFeedFiles, runSiteJobCycle } from "../src/site/jobs.js";

let backendDb: BackendDb | null = null;
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
    const metricsJson = path.join(tempDir, "metrics.json");
    const config = loadConfig({ FEED_JSON: feedJson, SITE_METRICS_JSON: metricsJson, SITE_PUBLIC_DIR: tempDir });
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
      SITE_METRICS_JSON: path.join(tempDir, "metrics.json"),
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
});
