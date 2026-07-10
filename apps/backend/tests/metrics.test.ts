import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
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
      expect(backendDb.sqlite.prepare("SELECT metric_name, value, source FROM post_metrics ORDER BY metric_name").all()).toEqual([
        { metric_name: "likes", value: 9, source: "test_api" },
        { metric_name: "views", value: 120, source: "test_api" },
      ]);
      expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM metric_samples").get() as { count: number }).count).toBe(2);
      expect(backendDb.sqlite.prepare("SELECT check_count, last_error FROM metric_schedule").get()).toEqual({ check_count: 1, last_error: null });
      expect(JSON.parse((backendDb.sqlite.prepare("SELECT state_json FROM worker_state WHERE name='metrics'").get() as { state_json: string }).state_json)).toMatchObject({ checked: 1, ok: true, last_error: null });
    } finally {
      backendDb.close();
    }
  });

  it("stores collector errors and advances the durable schedule", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedPublishedPost(backendDb, "post:2", "devto");
      await runMetricsCycle(loadConfig({}), backendDb, { devto: async () => { throw new Error("upstream unavailable"); } });
      expect(backendDb.sqlite.prepare("SELECT value, error FROM post_metrics").get()).toEqual({ value: null, error: "upstream unavailable" });
      expect(backendDb.sqlite.prepare("SELECT check_count, last_error FROM metric_schedule").get()).toEqual({ check_count: 1, last_error: "upstream unavailable" });
    } finally {
      backendDb.close();
    }
  });
});

describe("Telegram public metrics", () => {
  it("parses compact views and sums reactions", async () => {
    const html = `<section><div data-post="alexgetmancom/42"><span class="tgme_widget_message_views">1.2K</span><span class="tgme_reaction"><i></i>3</span><span class="tgme_reaction"><i></i>2</span></div></section>`;
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const collector = createMetricCollectors(loadConfig({}), fetchImpl).telegram!;
    const result = await collector(task("telegram"));
    expect(result).toMatchObject({ metrics: { views: 1200, likes: 5 }, source: "t_me_public" });
  });
});

function seedPublishedPost(backendDb: ReturnType<typeof openBackendDb>, postKey: string, target: string): void {
  const date = new Date(Date.now() - 2 * 3_600_000).toISOString();
  backendDb.sqlite.prepare(
    "INSERT INTO posts(post_key, channel, message_id, date_utc, status, created_at, updated_at) VALUES (?, 'alexgetmancom', 42, ?, 'active', ?, ?)",
  ).run(postKey, date, date, date);
  backendDb.sqlite.prepare(
    "INSERT INTO post_targets(post_key, target, status, external_id, url, updated_at) VALUES (?, ?, 'published', 'external-1', 'https://dev.to/alex/post', ?)",
  ).run(postKey, target, date);
}

function task(target: string): MetricTask {
  return { postKey: "post:42", target, checkCount: 0, messageId: 42, dateUtc: new Date().toISOString(), externalId: "42", externalIds: ["42"], url: null };
}
