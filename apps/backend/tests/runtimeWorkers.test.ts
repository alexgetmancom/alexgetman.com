import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { workerState } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { startCoreWorkers } from "../src/runtime/workers.js";
import { withDb } from "./helpers/db.js";

const EXPECTED_WORKERS = [
  "story-cards",
  "queue",
  "publish-watchdog",
  "publication-reconciliation",
  "notifications",
  "video",
  "metrics",
  "creator-analytics",
  "metric-retention",
  "site",
  "site-watchdog",
  "media-cache",
  "operational-retention",
  "observability",
];

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("core worker runtime", () => {
  it("starts every enabled loop and persists lifecycle heartbeats", async () => {
    await withDb(async (backendDb) => {
      const config = loadConfig({ WORKER_HEARTBEAT_INTERVAL_SECONDS: "1" });
      config.studio.modules.video_posting = true;
      config.studio.modules.analytics = true;
      config.studio.modules.site = true;
      const loops = startCoreWorkers(config, backendDb);

      try {
        expect(loops.map((loop) => loop.name)).toEqual(EXPECTED_WORKERS);
        await wait(1_100);

        const states = backendDb.db
          .select()
          .from(workerState)
          .all()
          .filter((state) => EXPECTED_WORKERS.includes(state.name));
        expect(states.map((state) => state.name).sort()).toEqual([...EXPECTED_WORKERS].sort());
        expect(states.every((state) => state.stateJson.scheduler_error === null)).toBe(true);
        expect(states.every((state) => typeof state.stateJson.last_heartbeat_at === "string")).toBe(true);
        expect(
          backendDb.db.select({ name: workerState.name }).from(workerState).where(eq(workerState.name, "observability")).get(),
        ).toEqual({ name: "observability" });
      } finally {
        for (const loop of loops) loop.stop();
      }
    });
  });
});
