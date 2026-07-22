import { describe, expect, it } from "bun:test";
import { openBackendDb } from "../src/db/client.js";
import { creatorProfileSnapshots, creatorProfiles, metricSamples } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { renderAudienceSection } from "../src/operations/dashboard/ops-sections.js";

describe("Command Center audience projection", () => {
  it("keeps the four core audience accounts visible in the compact overview", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
      backendDb.db
        .insert(creatorProfiles)
        .values([
          { platform: "threads_ru", dataJson: { followersCount: 180, manual: true }, updatedAt: now },
          { platform: "threads_en", dataJson: { followersCount: 20, manual: true }, updatedAt: now },
        ])
        .run();
      backendDb.db
        .insert(creatorProfileSnapshots)
        .values([
          {
            platform: "threads_ru",
            account: "ru",
            sampledOn: "2026-07-08",
            metricsJson: { followersCount: 170 },
            source: "manual",
            sampledAt: eightDaysAgo,
          },
          {
            platform: "threads_ru",
            account: "ru",
            sampledOn: "2026-07-16",
            metricsJson: { followersCount: 180 },
            source: "manual",
            sampledAt: now,
          },
        ])
        .run();
      backendDb.db
        .insert(metricSamples)
        .values([
          { postKey: "post:1", target: "threads_ru", metricName: "views", value: 10, sampledAt: eightDaysAgo },
          { postKey: "post:1", target: "threads_ru", metricName: "views", value: 35, sampledAt: now },
          { postKey: "post:1", target: "threads_ru", metricName: "likes", value: 2, sampledAt: eightDaysAgo },
          { postKey: "post:1", target: "threads_ru", metricName: "likes", value: 5, sampledAt: now },
        ])
        .run();

      const html = renderAudienceSection(backendDb, loadConfig({}));
      expect(html).toContain("Threads RU");
      expect(html).toContain("Threads EN");
      expect(html).toContain("Telegram");
      expect(html).toContain(">180<");
      expect(html).toContain(">20<");
      expect(html).toContain('class="audience-panel"');
      expect(html).not.toContain("Facebook EN");
    } finally {
      backendDb.close();
    }
  });
});
