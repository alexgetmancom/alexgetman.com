import { describe, expect, it } from "bun:test";
import { creatorDashboard } from "../src/analytics/reports/dashboard.js";
import { studioAnalyticsDashboard } from "../src/analytics/reports/studio-dashboard.js";
import { pruneMetricSamples } from "../src/analytics/snapshots/metric-repository.js";
import { creatorProfiles, metricSamples, posts, postTargets, videoMetricSnapshots } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { insertPublishedVideo } from "./helpers/analytics.js";
import { withDb } from "./helpers/db.js";

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
        .values({ platform: "youtube", dataJson: { subscriberCount: 117 }, updatedAt: now })
        .run();

      const config = loadConfig({});
      config.studio.modules.video_posting = true;
      config.studio.modules.youtube = true;
      const dashboard = creatorDashboard(backendDb, config, 7);
      expect(dashboard.text).toContain("Видео: 1200 просмотров · 96 взаимодействий");
      expect(dashboard.text).toContain("YouTube: 1200 просмотров · 87 лайков · 117 подписчиков");
      expect(dashboard.text).toContain("Hades, часть 3 — 1200 просмотров");
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
      const config = loadConfig({});
      config.studio.modules.text_posting = true;
      const overview = studioAnalyticsDashboard(backendDb, config, "overview", 1, "ru").text;
      const postsView = studioAnalyticsDashboard(backendDb, config, "posts", 1, "ru").text;

      expect(overview).not.toContain("Общая статистика");
      expect(overview).toContain("| ✈️ Telegram | 0 | — | 24 | 5 | 0 | — | — |");
      // No platform has a growth baseline here, so the total is unknown too —
      // the same "—" the Telegram row shows, not a confident "+0".
      expect(postsView).toContain("| 📊 Все | 0 | — | 24 | 5 | 0 | — | — |");
      expect(studioAnalyticsDashboard(backendDb, config, "overview", 1, "ru").richHtml).toContain("<table bordered striped>");
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
        .values({ platform: "instagram", dataJson: { followersCount: 306, views1d: 63_394, likes1d: 1_227 }, updatedAt: now })
        .run();
      const config = loadConfig({});
      config.studio.modules.video_posting = true;
      config.studio.modules.instagram = true;
      config.studio.modules.youtube = true;

      const dashboard = studioAnalyticsDashboard(backendDb, config, "video", 1, "ru");
      expect(dashboard.text).not.toContain("Аккаунт ·");
      expect(dashboard.text).toContain("| 📸 Instagram | 306 | — | 63394 | 1227");
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
      const config = loadConfig({});
      config.studio.modules.text_posting = true;

      const dashboard = studioAnalyticsDashboard(backendDb, config, "posts", 1, "ru");
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
      const config = loadConfig({});
      config.studio.modules.text_posting = true;

      // 50 views of growth, not 950 lifetime and not a dropped row: with the
      // baseline pruned there is no third answer the report could give.
      expect(studioAnalyticsDashboard(backendDb, config, "posts", 30, "ru").text).toContain("| ✈️ Telegram | 0 | — | 50 |");
    });
  });

  it("scopes a video-only Studio audience to its enabled video platforms", async () => {
    await withDb(async (backendDb) => {
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
      expect(overview).toContain("| 📊 Все | 426 | —");
      expect(overview).not.toContain("556");
      expect(audience).toContain("Instagram");
      expect(audience).toContain("YouTube");
      expect(audience).not.toContain("Telegram");
    });
  });

  it("keeps the overview compact when a requested period predates collected history", async () => {
    await withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(metricSamples)
        .values({ postKey: "post:1", target: "telegram", metricName: "views", value: 10, sampledAt: now })
        .run();
      const config = loadConfig({});
      config.studio.modules.text_posting = true;

      const dashboard = studioAnalyticsDashboard(backendDb, config, "posts", 30, "en").text;
      expect(dashboard).not.toContain("History has been collected since");
    });
  });
});
