import { describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { openBackendDb } from "../src/db/client.js";
import { alertDedup, credentialChecks, postEvents, publishJobs, siteJobs, workerState } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { runObservabilityCycle } from "../src/observability/cycle.js";
import { recordMemoryPressure } from "../src/observability/runtime-health.js";

function testHarness() {
  const backendDb = openBackendDb(":memory:");
  const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
  const alertsPort = { sendAlert: async (_text: string) => void (await sendMessage()) };
  const config = loadConfig({ ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "token", ALERT_COOLDOWN_SECONDS: "3600" });
  return { backendDb, sendMessage, alertsPort, config };
}

function recordFailure(backendDb: ReturnType<typeof openBackendDb>, message: string): void {
  backendDb.db
    .insert(postEvents)
    .values({ eventType: "publish.failed", severity: "error", target: "x", message, createdAt: new Date().toISOString() })
    .run();
}

function countEvents(backendDb: ReturnType<typeof openBackendDb>, eventType: string): number {
  return backendDb.db.select().from(postEvents).where(eq(postEvents.eventType, eventType)).all().length;
}

describe("observability", () => {
  it("checks credentials and alerts the owner on a failure", async () => {
    const { backendDb, sendMessage, alertsPort, config } = testHarness();
    try {
      recordFailure(backendDb, "API unavailable");
      expect(await runObservabilityCycle(config, backendDb, alertsPort)).toMatchObject({ alerts: 1 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(backendDb.db.select().from(credentialChecks).all().length).toBeGreaterThan(8);
    } finally {
      backendDb.close();
    }
  });

  it("deduplicates a repeated error within the cooldown and counts the suppression", async () => {
    const { backendDb, sendMessage, alertsPort, config } = testHarness();
    try {
      recordFailure(backendDb, "API unavailable");
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      recordFailure(backendDb, "API unavailable");
      expect(await runObservabilityCycle(config, backendDb, alertsPort)).toMatchObject({ alerts: 0 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(backendDb.db.select({ suppressedCount: alertDedup.suppressedCount }).from(alertDedup).get()?.suppressedCount).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("reports a stale queue lock exactly once", async () => {
    const { backendDb, config } = testHarness();
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          postKey: "post:stale",
          messageId: 1,
          target: "threads",
          status: "publishing",
          lockedAt: "2000-01-01T00:00:00.000Z",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "queue.stale")).toBe(1);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "queue.stale")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("reports a failed site build", async () => {
    const { backendDb, config } = testHarness();
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(siteJobs)
        .values({
          postId: 7,
          messageId: 7,
          reason: "publish_ru",
          status: "failed",
          lastError: "Astro build failed",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "site.build.failed")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("does not re-alert on a terminal social job that already reported at its transition", async () => {
    const { backendDb, config } = testHarness();
    try {
      // A terminal social job emits publish.job.failed at its state transition.
      // Observability must not generate a fresh target.failed alert every hour.
      const now = new Date().toISOString();
      backendDb.db
        .insert(publishJobs)
        .values({
          postKey: "post:terminal",
          messageId: 8,
          target: "telegram_stories",
          status: "failed",
          lastError: "MEDIA_FILE_INVALID",
          payloadJson: {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await runObservabilityCycle(config, backendDb);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "target.failed")).toBe(0);
    } finally {
      backendDb.close();
    }
  });
});

function seedPreviousBoot(backendDb: ReturnType<typeof openBackendDb>, restartsAt: string[]): void {
  const now = new Date().toISOString();
  backendDb.db
    .insert(workerState)
    .values({
      name: "runtime",
      stateJson: { bootId: "previous-process", bootedAt: new Date(Date.now() - 60_000).toISOString(), restartsAt },
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: workerState.name, set: { updatedAt: now } })
    .run();
}

describe("runtime health", () => {
  it("adopts the runtime identity silently on a fresh database", async () => {
    const { backendDb, config } = testHarness();
    try {
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(0);
      expect(backendDb.db.select().from(workerState).where(eq(workerState.name, "runtime")).get()).toBeTruthy();
    } finally {
      backendDb.close();
    }
  });

  it("records a single restart as info so a deploy does not page the owner", async () => {
    const { backendDb, sendMessage, alertsPort, config } = testHarness();
    try {
      seedPreviousBoot(backendDb, []);
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
      // Alert delivery only picks up warn/error, so an ordinary restart must not
      // reach the transport.
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      backendDb.close();
    }
  });

  it("reports the same process only once across repeated cycles", async () => {
    const { backendDb, config } = testHarness();
    try {
      seedPreviousBoot(backendDb, []);
      await runObservabilityCycle(config, backendDb);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("escalates to an alert when restarts cluster inside the window", async () => {
    const { backendDb, sendMessage, alertsPort, config } = testHarness();
    try {
      const recent = [new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString()];
      seedPreviousBoot(backendDb, recent);
      await runObservabilityCycle(config, backendDb, alertsPort);
      expect(countEvents(backendDb, "runtime.restart.looping")).toBe(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      backendDb.close();
    }
  });

  it("ignores restarts that fell out of the window", async () => {
    const { backendDb, config } = testHarness();
    try {
      const stale = [new Date(Date.now() - 5 * 3600_000).toISOString(), new Date(Date.now() - 4 * 3600_000).toISOString()];
      seedPreviousBoot(backendDb, stale);
      await runObservabilityCycle(config, backendDb);
      expect(countEvents(backendDb, "runtime.restart.looping")).toBe(0);
      expect(countEvents(backendDb, "runtime.restarted")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("warns once when rss crosses the container limit threshold", () => {
    const { backendDb, config } = testHarness();
    try {
      const tightLimit = Math.round(process.memoryUsage().rss / 0.99);
      expect(recordMemoryPressure(config, backendDb, tightLimit)).toBe(true);
      expect(recordMemoryPressure(config, backendDb, tightLimit)).toBe(false);
      expect(countEvents(backendDb, "runtime.memory.pressure")).toBe(1);
    } finally {
      backendDb.close();
    }
  });

  it("stays quiet below the threshold and when no cgroup limit applies", () => {
    const { backendDb, config } = testHarness();
    try {
      expect(recordMemoryPressure(config, backendDb, process.memoryUsage().rss * 100)).toBe(false);
      expect(recordMemoryPressure(config, backendDb, null)).toBe(false);
      expect(countEvents(backendDb, "runtime.memory.pressure")).toBe(0);
    } finally {
      backendDb.close();
    }
  });
});
