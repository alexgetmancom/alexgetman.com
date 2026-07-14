import { describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { alertDedup, credentialChecks, postEvents, publishJobs, siteJobs } from "../src/db/schema.js";
import { runObservabilityCycle } from "../src/operations/observability.js";

describe("observability", () => {
  it("checks credentials, alerts the owner and deduplicates repeated errors", async () => {
    const backendDb = openBackendDb(":memory:");
    const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
    const bot = { api: { sendMessage } } as unknown as Bot;
    const config = loadConfig({ ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "token", ALERT_COOLDOWN_SECONDS: "3600" });
    try {
      backendDb.db
        .insert(postEvents)
        .values({
          eventType: "publish.failed",
          severity: "error",
          target: "x",
          message: "API unavailable",
          createdAt: new Date().toISOString(),
        })
        .run();
      expect(await runObservabilityCycle(config, backendDb, bot)).toMatchObject({ alerts: 1 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(backendDb.db.select().from(credentialChecks).all().length).toBeGreaterThan(10);

      backendDb.db
        .insert(postEvents)
        .values({
          eventType: "publish.failed",
          severity: "error",
          target: "x",
          message: "API unavailable",
          createdAt: new Date().toISOString(),
        })
        .run();
      expect(await runObservabilityCycle(config, backendDb, bot)).toMatchObject({ alerts: 0 });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(backendDb.db.select({ suppressedCount: alertDedup.suppressedCount }).from(alertDedup).get()?.suppressedCount).toBe(1);

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
      await runObservabilityCycle(config, backendDb, null);
      expect(backendDb.db.select().from(postEvents).where(eq(postEvents.eventType, "queue.stale")).all().length).toBe(1);
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
      await runObservabilityCycle(config, backendDb, null);
      expect(backendDb.db.select().from(postEvents).where(eq(postEvents.eventType, "site.build.failed")).all()).toHaveLength(1);
      await runObservabilityCycle(config, backendDb, null);
      expect(backendDb.db.select().from(postEvents).where(eq(postEvents.eventType, "queue.stale")).all().length).toBe(1);
    } finally {
      backendDb.close();
    }
  });
});
