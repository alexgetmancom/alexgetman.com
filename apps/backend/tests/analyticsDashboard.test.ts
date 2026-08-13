import { describe, expect, it } from "bun:test";
import { creatorDashboard } from "../src/analytics/reports/dashboard.js";
import { studioAnalyticsDashboard } from "../src/analytics/reports/studio-dashboard.js";
import { pruneMetricSamples } from "../src/analytics/snapshots/metric-repository.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { creatorProfiles, metricSamples, posts, postTargets, videoMetricSnapshots } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { TEXT_TEST_CHANNELS, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { withDb as withFixtureDb } from "./helpers/db.js";

const withDb = <T>(run: (backendDb: UnsafeBackendDb) => T | Promise<T>) =>
  withFixtureDb(run, [...TEXT_TEST_CHANNELS, ...VIDEO_TEST_CHANNELS]);

describe("creator analytics dashboards", () => {
  it("builds a compact video dashboard from cached platform data", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const { targetId } = insertPublishedVideo(backendDb, { label: "Hades, часть 3", target: "youtube_shorts", publishedAt: now });
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: targetId,
          platform: "youtube_shorts",
          metricsJson: { views: 1200, likes: 87, comments: 9 },
          sampledAt: now,
        })
        .run();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          { platform: "youtube_ru", dataJson: { subscriberCount: 117 }, updatedAt: now },
          { platform: "youtube_en", dataJson: { subscriberCount: 13 }, updatedAt: now },
        ])
        .run();

      const config = loadConfig({});
      const dashboard = creatorDashboard(backendDb, config, 7);
      expect(dashboard.text).toContain("Видео: 1200 просмотров · 96 взаимодействий");
      expect(dashboard.text).toContain("YouTube: 1200 просмотров · 87 лайков · 130 подписчиков");
      expect(dashboard.text).toContain("Hades, часть 3 — 1200 просмотров");
    });
  });

  it("renders the overall creator dashboard from every connected account source", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          {
            platform: "youtube_ru",
            dataJson: {
              subscriberCount: 10,
              viewCount: 2_000,
              videoCount: 7,
              views: 500,
              estimatedMinutesWatched: 60,
              subscribersGained: 4,
              subscribersLost: 1,
            },
            updatedAt: now,
          },
          {
            platform: "instagram_ru",
            dataJson: {
              followersCount: 306,
              mediaCount: 12,
              reach30d: 1_000,
              views30d: 900,
              interactions30d: 80,
              saves30d: 20,
              shares30d: 10,
              reposts30d: 5,
            },
            updatedAt: now,
          },
        ])
        .run();

      const config = loadConfig({});

      const dashboard = creatorDashboard(backendDb, config, 0, "en");
      expect(dashboard.text).toContain("Overall statistics");
      expect(dashboard.text).toContain("Site: 0 material views");
      expect(dashboard.text).toContain("Posts: 0 views · 0 interactions");
      expect(dashboard.text).toContain("Subscribers: 10");
      expect(dashboard.text).toContain("Lifetime views: 2000");
      expect(dashboard.text).toContain("Watch time: 1.0 h");
      expect(dashboard.text).toContain("Followers: 306");
      expect(dashboard.text).toContain("Total Reels/posts: 12");
      expect(dashboard.text).toContain("30 days: reach 1000");
    });
  });

  it("renders the compact Studio overview and keeps post and video analytics separate", async () => {
    await withDb(async (backendDb) => {
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
      const overview = studioAnalyticsDashboard(backendDb, "overview", 1, "ru").text;
      const postsView = studioAnalyticsDashboard(backendDb, "posts", 1, "ru").text;

      expect(overview).not.toContain("Общая статистика");
      expect(overview).toContain("| ✈️ Telegram | 0 | — | 24 | 5 | 0 | — | — |");
      // No platform has a growth baseline here, so the total is unknown too —
      // the same "—" the Telegram row shows, not a confident "+0".
      expect(postsView).toContain("| 📊 Все | 0 | — | 24 | 5 | 0 | — | — |");
      expect(studioAnalyticsDashboard(backendDb, "overview", 1, "ru").richHtml).toContain("<table bordered striped>");
      expect(postsView).not.toContain("Видеопостинг");
    });
  });

  it("separates account activity from videos published in the selected period", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const { targetId } = insertPublishedVideo(backendDb, {
        label: "Симулятор фермы, который удивит",
        target: "instagram_reels",
        publishedAt: now,
      });
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: targetId,
          platform: "instagram_reels",
          metricsJson: { views: 200, likes: 20, shares: 7, saves: 5 },
          sampledAt: now,
        })
        .run();
      backendDb.db
        .insert(creatorProfiles)
        .values({ platform: "instagram_ru", dataJson: { followersCount: 306, views1d: 63_394, likes1d: 1_227 }, updatedAt: now })
        .run();
      const dashboard = studioAnalyticsDashboard(backendDb, "video", 1, "ru");
      expect(dashboard.text).not.toContain("Аккаунт ·");
      expect(dashboard.text).toContain("| 📸 Instagram RU | 306 | — | 63394 | 1227");
      expect(dashboard.text).toContain("| Видео | 👁 | ♥ | 💬 | ↗ | 🔖 |");
      expect(dashboard.text).toContain("| Все | 200 | 20 | 0 | 7 | 5 |");
      expect(dashboard.text).toContain("| Симулятор… · 📸 RU | 200 | 20 | 0 | 7 | 5 |");
      expect(dashboard.text).not.toContain("| Симулятор… · ▶️ |");
      expect(dashboard.richHtml.match(/<table bordered striped>/g)?.length).toBe(2);
      expect(dashboard.richHtml).not.toContain("|:--");
    });
  });

  it("renders newly published text posts below Alex's account table", async () => {
    await withDb(async (backendDb) => {
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
      const dashboard = studioAnalyticsDashboard(backendDb, "posts", 1, "ru");
      expect(dashboard.text).toContain("| Пост | 👁 | ♥ | 💬 | ↗ | 🔖 |");
      expect(dashboard.text).toContain("| Все | 200 | 20 | 0 | 7 | — |");
      expect(dashboard.text).toContain("| Релиз нов… · ✈️ | 200 | 20 | 0 | 7 | — |");
      expect(dashboard.richHtml.match(/<table bordered striped>/g)?.length).toBe(2);
    });
  });

  it("keeps the 30-day baseline a 30-day report needs after retention runs", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      const publishedAt = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
      // Before the 30-day window opens: this is the checkpoint the delta is
      // measured from, and the sample retention used to delete after 7 days.
      const beforePeriod = new Date(Date.now() - 33 * 24 * 60 * 60_000).toISOString();
      backendDb.db
        .insert(posts)
        .values({
          postKey: "post:1",
          channel: "telegram",
          messageId: 1,
          text: "Старый пост",
          dateUtc: publishedAt,
          createdAt: publishedAt,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:1", target: "telegram", status: "published", publishedAt, updatedAt: now })
        .run();
      backendDb.db
        .insert(metricSamples)
        .values([
          { postKey: "post:1", target: "telegram", metricName: "views", value: 900, sampledAt: beforePeriod },
          { postKey: "post:1", target: "telegram", metricName: "views", value: 950, sampledAt: now },
        ])
        .run();
      pruneMetricSamples(backendDb);
      // 50 views of growth, not 950 lifetime and not a dropped row: with the
      // baseline pruned there is no third answer the report could give.
      expect(studioAnalyticsDashboard(backendDb, "posts", 30, "ru").text).toContain("| ✈️ Telegram | 0 | — | 50 |");
    });
  });

  it("scopes the audience to the connected video platforms", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          { platform: "telegram", dataJson: { followersCount: 130 }, updatedAt: now },
          { platform: "youtube_ru", dataJson: { subscriberCount: 120 }, updatedAt: now },
          { platform: "instagram_ru", dataJson: { followersCount: 306 }, updatedAt: now },
        ])
        .run();
      const overview = studioAnalyticsDashboard(backendDb, "overview", 7, "ru").text;
      const audience = studioAnalyticsDashboard(backendDb, "audience", 7, "ru").text;
      expect(overview).toContain("| 📊 Все | 556 | —");
      expect(audience).toContain("Instagram");
      expect(audience).toContain("YouTube");
      expect(audience).toContain("Telegram");

      backendDb.channels.disable("instagram_en", now);
      backendDb.channels.disable("instagram_ru", now);
      const withoutInstagram = studioAnalyticsDashboard(backendDb, "audience", 7, "ru").text;
      expect(withoutInstagram).not.toContain("Instagram");
      expect(withoutInstagram).toContain("YouTube");
    });
  });

  it("keeps the overview compact when a requested period predates collected history", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSamples)
        .values({ postKey: "post:1", target: "telegram", metricName: "views", value: 10, sampledAt: now })
        .run();
      const dashboard = studioAnalyticsDashboard(backendDb, "posts", 30, "en").text;
      expect(dashboard).not.toContain("History has been collected since");
    });
  });
});
