import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { runAnalyticsCycle } from "../src/analytics/collection/creator-cycle.js";
import { creatorDashboard } from "../src/analytics/reports/dashboard.js";
import { studioAnalyticsDashboard } from "../src/analytics/reports/studio-dashboard.js";
import { openBackendDb } from "../src/db/client.js";
import { creatorProfiles, metricSamples, videoDrafts, videoMetricSchedule, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";

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
        .values({
          videoDraftId: draft.id,
          target: "youtube_shorts",
          metadataJson: {},
          status: "published",
          publishedAt: now,
          createdAt: now,
          updatedAt: now,
        })
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
      expect(await runAnalyticsCycle(loadConfig({}), backendDb)).toBe(0);
    } finally {
      backendDb.close();
    }
  });

  it("reports a video delta instead of a lifetime total for an older publication", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const publishedAt = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
      const beforePeriod = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
      const now = new Date().toISOString();
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({ adminId: 1, assetKey: "asset", label: "Older video", status: "published", createdAt: publishedAt, updatedAt: now })
        .returning({ id: videoDrafts.id })
        .get();
      if (!draft) throw new Error("video draft missing");
      const target = backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: draft.id,
          target: "youtube_shorts",
          metadataJson: {},
          status: "published",
          publishedAt,
          createdAt: publishedAt,
          updatedAt: now,
        })
        .returning({ id: videoTargets.id })
        .get();
      if (!target) throw new Error("video target missing");
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({ videoTargetId: target.id, platform: "youtube_shorts", metricsJson: { views: 100, likes: 5 }, sampledAt: beforePeriod })
        .run();
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({ videoTargetId: target.id, platform: "youtube_shorts", metricsJson: { views: 180, likes: 8 }, sampledAt: now })
        .run();
      const config = loadConfig({});
      config.studio.modules.video_posting = true;
      config.studio.modules.youtube = true;

      expect(creatorDashboard(backendDb, config, 1).text).toContain("Видео: 80 просмотров · 3 взаимодействий");
    } finally {
      backendDb.close();
    }
  });

  it("uses metric sample deltas for text and site periods", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const before = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSamples)
        .values([
          { postKey: "post:1", target: "site_ru", metricName: "views", value: 100, sampledAt: before },
          { postKey: "post:1", target: "site_ru", metricName: "views", value: 145, sampledAt: now },
          { postKey: "post:2", target: "telegram", metricName: "views", value: 20, sampledAt: before },
          { postKey: "post:2", target: "telegram", metricName: "views", value: 50, sampledAt: now },
          { postKey: "post:2", target: "telegram", metricName: "likes", value: 4, sampledAt: before },
          { postKey: "post:2", target: "telegram", metricName: "likes", value: 9, sampledAt: now },
        ])
        .run();
      const config = loadConfig({});
      config.studio.modules.site = true;
      config.studio.modules.text_posting = true;

      const text = creatorDashboard(backendDb, config, 1).text;
      expect(text).toContain("Сайт: 45 просмотров материалов");
      expect(text).toContain("Посты: 30 просмотров · 5 реакций");
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
      await runAnalyticsCycle(config, backendDb, fetchMock);

      expect(backendDb.db.select().from(videoMetricSnapshots).all()).toHaveLength(1);
      const schedule = backendDb.db.select().from(videoMetricSchedule).where(eq(videoMetricSchedule.videoTargetId, target.id)).get();
      expect(schedule?.checkpointIndex).toBe(1);
      expect(new Date(schedule?.nextCheckAt ?? 0).getTime()).toBe(new Date(publishedAt).getTime() + 4 * 60 * 60_000);
    } finally {
      backendDb.close();
    }
  });

  it("renders the compact Studio overview and keeps post and video analytics separate", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const before = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSamples)
        .values([
          { postKey: "post:1", target: "telegram", metricName: "views", value: 10, sampledAt: before },
          { postKey: "post:1", target: "telegram", metricName: "views", value: 34, sampledAt: now },
          { postKey: "post:1", target: "telegram", metricName: "likes", value: 2, sampledAt: before },
          { postKey: "post:1", target: "telegram", metricName: "likes", value: 7, sampledAt: now },
        ])
        .run();
      const config = loadConfig({});
      config.studio.modules.text_posting = true;
      const overview = studioAnalyticsDashboard(backendDb, config, "overview", 1, "ru").text;
      const posts = studioAnalyticsDashboard(backendDb, config, "posts", 1, "ru").text;

      expect(overview).toContain("Общая статистика · сегодня");
      expect(overview).toContain("Просмотры контента: *24*");
      expect(overview).toContain("Взаимодействия: *5*");
      expect(posts).toContain("Постинг · сегодня");
      expect(posts).toContain("Просмотры постов: *24*");
      expect(posts).not.toContain("Видеопостинг");
    } finally {
      backendDb.close();
    }
  });

  it("tells the user when a requested analytics period predates collected history", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSamples)
        .values({ postKey: "post:1", target: "telegram", metricName: "views", value: 10, sampledAt: now })
        .run();
      const config = loadConfig({});
      config.studio.modules.text_posting = true;

      const dashboard = studioAnalyticsDashboard(backendDb, config, "posts", 30, "en").text;
      expect(dashboard).toContain("History has been collected since");
      expect(dashboard).toContain("comparison is not complete yet");
    } finally {
      backendDb.close();
    }
  });
});
