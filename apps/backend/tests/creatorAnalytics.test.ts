import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { creatorDashboard, runCreatorAnalyticsCycle } from "../src/analytics/creator.js";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { creatorProfiles, videoDrafts, videoMetricSchedule, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";

describe("creator analytics", () => {
  it("builds a compact video dashboard from cached platform data", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({ adminId: 1, assetKey: "asset", label: "Hades, часть 3", status: "published", createdAt: now, updatedAt: now })
        .returning({ id: videoDrafts.id })
        .get();
      if (!draft) throw new Error("video draft missing");
      const target = backendDb.db
        .insert(videoTargets)
        .values({ videoDraftId: draft.id, target: "youtube_shorts", metadataJson: {}, status: "published", createdAt: now, updatedAt: now })
        .returning({ id: videoTargets.id })
        .get();
      if (!target) throw new Error("video target missing");
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: target.id,
          platform: "youtube_shorts",
          metricsJson: { views: 1200, likes: 87, comments: 9 },
          sampledAt: now,
        })
        .run();
      backendDb.db
        .insert(creatorProfiles)
        .values({ platform: "youtube", dataJson: { subscriberCount: 117 }, updatedAt: now })
        .run();

      const config = loadConfig({});
      config.studio.modules.video_posting = true;
      config.studio.modules.youtube = true;
      const dashboard = creatorDashboard(backendDb, config, 7);
      expect(dashboard.text).toContain("Видео: 1200 просмотров · 96 взаимодействий");
      expect(dashboard.text).toContain("YouTube: 1200 просмотров · 87 лайков · 117 подписчиков");
      expect(dashboard.text).toContain("Hades, часть 3 — 1200 просмотров");
    } finally {
      backendDb.close();
    }
  });

  it("does not call creator APIs when the video module is disabled", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      expect(await runCreatorAnalyticsCycle(loadConfig({}), backendDb)).toBe(0);
    } finally {
      backendDb.close();
    }
  });

  it("uses fixed publication-time checkpoints for video metrics", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const publishedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({ adminId: 1, assetKey: "asset", label: "Hades", status: "published", createdAt: publishedAt, updatedAt: publishedAt })
        .returning({ id: videoDrafts.id })
        .get();
      if (!draft) throw new Error("video draft missing");
      const target = backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: draft.id,
          target: "instagram_reels",
          metadataJson: {},
          status: "published",
          externalId: "reel-1",
          publishedAt,
          createdAt: publishedAt,
          updatedAt: publishedAt,
        })
        .returning({ id: videoTargets.id })
        .get();
      if (!target) throw new Error("video target missing");
      const config = loadConfig({ INSTAGRAM_ACCESS_TOKEN: "token", INSTAGRAM_USER_ID: "user" });
      config.studio.modules.video_posting = true;
      config.studio.modules.instagram = true;
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("/comments")) return new Response(JSON.stringify({ data: [] }));
        if (url.includes("reel-1")) return new Response(JSON.stringify({ plays: 20, like_count: 2, comments_count: 1 }));
        return new Response(JSON.stringify({ username: "maru", followers_count: 10, media_count: 1 }));
      }) as typeof fetch;
      await runCreatorAnalyticsCycle(config, backendDb, fetchMock);

      expect(backendDb.db.select().from(videoMetricSnapshots).all()).toHaveLength(1);
      const schedule = backendDb.db.select().from(videoMetricSchedule).where(eq(videoMetricSchedule.videoTargetId, target.id)).get();
      expect(schedule?.checkpointIndex).toBe(1);
      expect(new Date(schedule?.nextCheckAt ?? 0).getTime()).toBe(new Date(publishedAt).getTime() + 4 * 60 * 60_000);
    } finally {
      backendDb.close();
    }
  });
});
