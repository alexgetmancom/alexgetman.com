import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { runAnalyticsCycle } from "../src/analytics/collection/creator-cycle.js";
import { audienceGrowthByPlatform } from "../src/analytics/metric-deltas.js";
import { creatorDashboard } from "../src/analytics/reports/dashboard.js";
import { studioAnalyticsDashboard } from "../src/analytics/reports/studio-dashboard.js";
import { openBackendDb } from "../src/db/client.js";
import {
  creatorProfileSnapshots,
  creatorProfiles,
  metricSamples,
  posts,
  postTargets,
  videoDrafts,
  videoMetricSchedule,
  videoMetricSnapshots,
  videoTargets,
} from "../src/db/schema.js";
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

  it("does not call analytics collectors when Analytics itself is disabled", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({});
      config.studio.modules.analytics = false;
      expect(await runAnalyticsCycle(config, backendDb)).toBe(0);
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
      expect(text).toContain("Посты: 30 просмотров · 5 взаимодействий");
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
      expect(new Date(schedule?.nextCheckAt ?? 0).getTime()).toBe(new Date(publishedAt).getTime() + 3 * 60 * 60_000);
    } finally {
      backendDb.close();
    }
  });

  it("collects Zernio Reel and account analytics without Meta credentials", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({ adminId: 1, assetKey: "asset", label: "Zernio Reel", status: "published", createdAt: now, updatedAt: now })
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
          deliveryProvider: "zernio",
          providerAccountId: "maru-account",
          providerPostId: "zernio-post",
          publishedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: videoTargets.id })
        .get();
      if (!target) throw new Error("video target missing");
      const config = loadConfig({
        ZERNIO_API_KEY: "a".repeat(16),
        PUBLISH_PROVIDER_ROUTES_JSON: '{"instagram_reels":{"provider":"zernio","accountId":"maru-account"}}',
      });
      config.studio.modules.analytics = true;
      config.studio.modules.video_posting = true;
      config.studio.modules.instagram = true;
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url === "https://zernio.com/api/v1/accounts")
          return new Response(JSON.stringify([{ _id: "maru-account", username: "marux_play", followersCount: 306 }]));
        if (url.includes("account-insights"))
          return new Response(
            JSON.stringify({
              metrics: {
                reach: { total: 100 },
                views: { total: 200 },
                total_interactions: { total: 20 },
                saves: { total: 5 },
                shares: { total: 7 },
              },
            }),
          );
        if (url.includes("follower-history"))
          return new Response(
            JSON.stringify({ metrics: { follower_count: { total: 0 }, followers_gained: { total: 8 }, followers_lost: { total: 2 } } }),
          );
        if (url.includes("postId=zernio-post"))
          return new Response(
            JSON.stringify({
              publishedAt: now,
              platformPostUrl: "https://www.instagram.com/reel/example/",
              analytics: { views: 200, likes: 20, comments: 3, reach: 160, shares: 7, saves: 5, follows: 2, igReelsAvgWatchTime: 7000 },
            }),
          );
        throw new Error(`unexpected URL: ${url}`);
      }) as typeof fetch;

      await runAnalyticsCycle(config, backendDb, fetchMock);

      expect(
        backendDb.db.select().from(videoMetricSnapshots).where(eq(videoMetricSnapshots.videoTargetId, target.id)).get()?.metricsJson,
      ).toMatchObject({
        views: 200,
        reach: 160,
        saves: 5,
        averageWatchTimeMs: 7000,
      });
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "instagram")).get()?.dataJson).toMatchObject({
        followersCount: 306,
        reach30d: 100,
        followersGained30d: 8,
      });
    } finally {
      backendDb.close();
    }
  });

  it("persists one daily profile observation while retaining the latest projection", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ GITHUB_DISCUSSIONS_TOKEN: "token" });
      config.studio.modules.video_posting = false;
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url === "https://api.github.com/user")
          return new Response(JSON.stringify({ login: "alex", followers: 48, following: 10, public_repos: 3 }));
        if (url.startsWith("https://api.github.com/user/repos"))
          return new Response(JSON.stringify([{ stargazers_count: 4 }, { stargazers_count: 7 }]));
        return new Response(JSON.stringify({ ok: true, result: 100 }));
      }) as typeof fetch;
      await runAnalyticsCycle(config, backendDb, fetchMock);
      await runAnalyticsCycle(config, backendDb, fetchMock);
      expect(backendDb.db.select().from(creatorProfileSnapshots).where(eq(creatorProfileSnapshots.platform, "github")).all()).toHaveLength(
        1,
      );
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "github")).get()?.dataJson).toMatchObject({
        followersCount: 48,
        stars: 11,
      });
      expect(studioAnalyticsDashboard(backendDb, config, "audience", 7, "ru").text).toContain("Stars: *11*");
    } finally {
      backendDb.close();
    }
  });

  it("changes audience growth with the selected period instead of repeating lifetime totals", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60_000).toISOString();
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values({ platform: "telegram", dataJson: { subscriberCount: 150 }, updatedAt: now })
        .run();
      backendDb.db
        .insert(creatorProfileSnapshots)
        .values([
          {
            platform: "telegram",
            account: "channel",
            sampledOn: "2026-06-11",
            metricsJson: { subscriberCount: 100 },
            source: "test",
            sampledAt: thirtyFiveDaysAgo,
          },
          {
            platform: "telegram",
            account: "channel",
            sampledOn: "2026-07-06",
            metricsJson: { subscriberCount: 120 },
            source: "test",
            sampledAt: tenDaysAgo,
          },
          {
            platform: "telegram",
            account: "channel",
            sampledOn: "2026-07-16",
            metricsJson: { subscriberCount: 150 },
            source: "test",
            sampledAt: now,
          },
        ])
        .run();
      const config = loadConfig({});

      const week = studioAnalyticsDashboard(backendDb, config, "audience", 7, "ru").text;
      const month = studioAnalyticsDashboard(backendDb, config, "audience", 30, "ru").text;
      expect(week).toContain("Аудитория · 7 дней");
      expect(week).toContain("прирост · 7 дней: *+30*");
      expect(month).toContain("Аудитория · 30 дней");
      expect(month).toContain("прирост · 30 дней: *+50*");
    } finally {
      backendDb.close();
    }
  });

  it("uses YouTube's native gained and lost subscriber reports for each selected period", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values({
          platform: "youtube",
          dataJson: { subscriberCount: 120, subscribersGained1d: 9, subscribersLost1d: 2, subscribersGained7d: 28, subscribersLost7d: 5 },
          updatedAt: now,
        })
        .run();
      const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
      expect(audienceGrowthByPlatform(backendDb, since, 1).get("youtube")).toBe(7);
      expect(audienceGrowthByPlatform(backendDb, since, 7).get("youtube")).toBe(23);
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

      expect(overview).not.toContain("Общая статистика");
      expect(overview).toContain("| ✈️ Telegram | — | 24 | 5 | 0 | 0 | 0 |");
      expect(posts).toContain("| 📊 Все | +0 | 24 | 5 | 0 | 0 | 0 |");
      expect(studioAnalyticsDashboard(backendDb, config, "overview", 1, "ru").richHtml).toContain("<table bordered striped>");
      expect(posts).not.toContain("Видеопостинг");
    } finally {
      backendDb.close();
    }
  });

  it("separates account activity from videos published in the selected period", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({
          adminId: 1,
          assetKey: "asset",
          label: "Симулятор фермы, который удивит",
          status: "published",
          createdAt: now,
          updatedAt: now,
        })
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
          platform: "instagram_reels",
          metricsJson: { views: 200, likes: 20, shares: 7, saves: 5 },
          sampledAt: now,
        })
        .run();
      backendDb.db
        .insert(creatorProfiles)
        .values({ platform: "instagram", dataJson: { followersCount: 306, views1d: 63_394, likes1d: 1_227 }, updatedAt: now })
        .run();
      const config = loadConfig({});
      config.studio.modules.video_posting = true;
      config.studio.modules.instagram = true;

      const dashboard = studioAnalyticsDashboard(backendDb, config, "video", 1, "ru");
      expect(dashboard.text).not.toContain("Аккаунт ·");
      expect(dashboard.text).toContain("| 📸 Instagram | +0 | 63394 | 1227");
      expect(dashboard.text).toContain("| Видео | 👁 | ♥ | 💬 | ↗ | 🔖 |");
      expect(dashboard.text).toContain("| Все | 200 | 20 | 0 | 7 | 5 |");
      expect(dashboard.text).toContain("| Симулятор… · 📸 | 200 | 20 | 0 | 7 | 5 |");
      expect(dashboard.richHtml.match(/<table bordered striped>/g)?.length).toBe(2);
    } finally {
      backendDb.close();
    }
  });

  it("renders newly published text posts below Alex's account table", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(posts)
        .values({
          postKey: "post:1",
          channel: "telegram",
          messageId: 1,
          text: "Релиз новой функции",
          dateUtc: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db.insert(postTargets).values({ postKey: "post:1", target: "telegram", status: "published", updatedAt: now }).run();
      backendDb.db
        .insert(metricSamples)
        .values([
          { postKey: "post:1", target: "telegram", metricName: "views", value: 200, sampledAt: now },
          { postKey: "post:1", target: "telegram", metricName: "likes", value: 20, sampledAt: now },
          { postKey: "post:1", target: "telegram", metricName: "reposts", value: 7, sampledAt: now },
        ])
        .run();
      const config = loadConfig({});
      config.studio.modules.text_posting = true;

      const dashboard = studioAnalyticsDashboard(backendDb, config, "posts", 1, "ru");
      expect(dashboard.text).toContain("| Пост | 👁 | ♥ | 💬 | ↗ | 🔖 |");
      expect(dashboard.text).toContain("| Все | 200 | 20 | 0 | 7 | — |");
      expect(dashboard.text).toContain("| Релиз нов… · ✈️ | 200 | 20 | 0 | 7 | — |");
      expect(dashboard.richHtml.match(/<table bordered striped>/g)?.length).toBe(2);
    } finally {
      backendDb.close();
    }
  });

  it("scopes a video-only Studio audience to its enabled video platforms", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          { platform: "telegram", dataJson: { followersCount: 130 }, updatedAt: now },
          { platform: "youtube", dataJson: { subscriberCount: 120 }, updatedAt: now },
          { platform: "instagram", dataJson: { followersCount: 306 }, updatedAt: now },
        ])
        .run();
      const config = loadConfig({});
      config.studio.modules.text_posting = false;
      config.studio.modules.video_posting = true;
      config.studio.modules.youtube = true;
      config.studio.modules.instagram = true;

      const overview = studioAnalyticsDashboard(backendDb, config, "overview", 7, "ru").text;
      const audience = studioAnalyticsDashboard(backendDb, config, "audience", 7, "ru").text;
      expect(overview).toContain("👥 Подписчики 426");
      expect(overview).not.toContain("556");
      expect(audience).toContain("Instagram");
      expect(audience).toContain("YouTube");
      expect(audience).not.toContain("Telegram");
    } finally {
      backendDb.close();
    }
  });

  it("keeps the overview compact when a requested period predates collected history", () => {
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
      expect(dashboard).not.toContain("History has been collected since");
    } finally {
      backendDb.close();
    }
  });
});
