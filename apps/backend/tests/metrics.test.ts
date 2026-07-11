import { describe, expect, it, mock } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { metricSamples, metricSchedule, postMetrics, posts, postTargets, workerState } from "../src/db/schema.js";
import { createMetricCollectors } from "../src/metrics/collectors.js";
import { runMetricsCycle } from "../src/metrics/index.js";
import type { MetricTask } from "../src/metrics/schedule.js";

describe("metrics cycle", () => {
  it("schedules published targets and persists metric samples", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedPublishedPost(backendDb, "post:1", "devto");
      const checked = await runMetricsCycle(loadConfig({ MAX_METRIC_TASKS_PER_CYCLE: "10" }), backendDb, {
        devto: async () => ({ metrics: { views: 120, likes: 9 }, source: "test_api", raw: { id: 1 } }),
      });
      expect(checked).toBe(1);
      expect(
        backendDb.db
          .select({ metricName: postMetrics.metricName, value: postMetrics.value, source: postMetrics.source })
          .from(postMetrics)
          .orderBy(asc(postMetrics.metricName))
          .all(),
      ).toEqual([
        { metricName: "likes", value: 9, source: "test_api" },
        { metricName: "views", value: 120, source: "test_api" },
      ]);
      expect(backendDb.db.select().from(metricSamples).all()).toHaveLength(2);
      expect(
        backendDb.db.select({ checkCount: metricSchedule.checkCount, lastError: metricSchedule.lastError }).from(metricSchedule).get(),
      ).toEqual({ checkCount: 1, lastError: null });
      expect(
        backendDb.db.select({ stateJson: workerState.stateJson }).from(workerState).where(eq(workerState.name, "metrics")).get()?.stateJson,
      ).toMatchObject({
        checked: 1,
        ok: true,
        last_error: null,
      });
    } finally {
      backendDb.close();
    }
  });

  it("stores collector errors and advances the durable schedule", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedPublishedPost(backendDb, "post:2", "devto");
      await runMetricsCycle(loadConfig({}), backendDb, {
        devto: async () => {
          throw new Error("upstream unavailable");
        },
      });
      expect(backendDb.db.select({ value: postMetrics.value, error: postMetrics.error }).from(postMetrics).get()).toEqual({
        value: null,
        error: "upstream unavailable",
      });
      expect(
        backendDb.db.select({ checkCount: metricSchedule.checkCount, lastError: metricSchedule.lastError }).from(metricSchedule).get(),
      ).toEqual({ checkCount: 1, lastError: "upstream unavailable" });
    } finally {
      backendDb.close();
    }
  });
});

describe("Telegram public metrics", () => {
  it("parses compact views and sums reactions", async () => {
    const html = `<section><div data-post="alexgetmancom/42"><span class="tgme_widget_message_views">1.2K</span><span class="tgme_reaction"><i></i>3</span><span class="tgme_reaction"><i></i>2</span></div></section>`;
    const fetchImpl = mock(async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const collector = createMetricCollectors(loadConfig({}), fetchImpl).telegram;
    if (!collector) throw new Error("Telegram collector is missing");
    const result = await collector(task("telegram"));
    expect(result).toMatchObject({ metrics: { views: 1200, likes: 5 }, source: "t_me_public" });
  });
});

describe("Mastodon metrics", () => {
  it("normalizes an instance hostname without a protocol", async () => {
    const fetchImpl = mock(
      async () =>
        new Response(JSON.stringify({ favourites_count: 2, replies_count: 1, reblogs_count: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const collector = createMetricCollectors(loadConfig({ MASTODON_INSTANCE: "mastodon.social" }), fetchImpl).mastodon;
    if (!collector) throw new Error("Mastodon collector is missing");
    const result = await collector({ ...task("mastodon"), externalId: "123", externalIds: ["123"] });
    expect(fetchImpl).toHaveBeenCalledWith("https://mastodon.social/api/v1/statuses/123", expect.anything());
    expect(result.metrics).toEqual({ likes: 2, replies: 1, reposts: 3 });
  });
});

function seedPublishedPost(backendDb: ReturnType<typeof openBackendDb>, postKey: string, target: string): void {
  const date = new Date(Date.now() - 2 * 3_600_000).toISOString();
  backendDb.db
    .insert(posts)
    .values({ postKey, channel: "alexgetmancom", messageId: 42, dateUtc: date, status: "active", createdAt: date, updatedAt: date })
    .run();
  backendDb.db
    .insert(postTargets)
    .values({ postKey, target, status: "published", externalId: "external-1", url: "https://dev.to/alex/post", updatedAt: date })
    .run();
}

function task(target: string): MetricTask {
  return {
    postKey: "post:42",
    target,
    checkCount: 0,
    messageId: 42,
    dateUtc: new Date().toISOString(),
    externalId: "42",
    externalIds: ["42"],
    url: null,
  };
}
