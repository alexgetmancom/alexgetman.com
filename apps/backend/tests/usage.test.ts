import { describe, expect, it } from "bun:test";
import { recordUsage, trackUsageAsync, trackUsageSync, usageReport } from "../src/observability/usage.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("runtime usage telemetry", () => {
  it("aggregates successful and failed calls by day without changing operation errors", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      expect(trackUsageSync(backendDb, "test.operation", () => "ok")).toBe("ok");
      await expect(
        trackUsageAsync(backendDb, "test.operation", async () => {
          throw new Error("provider failed");
        }),
      ).rejects.toThrow("provider failed");

      const row = backendDb.sqlite
        .prepare("SELECT calls, successes, failures, total_duration_ms FROM runtime_usage WHERE feature_key=?")
        .get("test.operation") as { calls: number; successes: number; failures: number; total_duration_ms: number };
      expect(row.calls).toBe(2);
      expect(row.successes).toBe(1);
      expect(row.failures).toBe(1);
      expect(row.total_duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      backendDb.close();
    }
  });

  it("reports a window and marks known operations that have gone unused", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date("2026-08-01T12:00:00.000Z");
      recordUsage(backendDb, "publishing.plan.create", true, 12, new Date("2026-08-01T10:00:00.000Z"));
      recordUsage(backendDb, "publishing.plan.create", true, 20, new Date("2026-07-31T10:00:00.000Z"));
      recordUsage(backendDb, "old.operation", false, 80, new Date("2026-06-01T10:00:00.000Z"));

      const report = usageReport(backendDb, { days: 2, unusedDays: 30, now });
      const publishing = report.features.find((feature) => feature.featureKey === "publishing.plan.create");
      const old = report.features.find((feature) => feature.featureKey === "old.operation");
      const never = report.features.find((feature) => feature.featureKey === "publishing.video.job");
      expect(report.windowDays).toBe(2);
      expect(publishing).toMatchObject({ calls: 2, successes: 2, failures: 0, totalDurationMs: 32, daysWithCalls: 2, unused: false });
      expect(old).toMatchObject({ calls: 0, failures: 0, unused: true });
      expect(never).toMatchObject({ calls: 0, unused: true, firstSeenAt: null, lastSeenAt: null });
    } finally {
      backendDb.close();
    }
  });
});
