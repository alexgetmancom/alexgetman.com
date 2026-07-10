import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { runObservabilityCycle } from "../src/services/observability.js";

describe("observability", () => {
  it("checks credentials, alerts the owner and deduplicates repeated errors", async () => {
    const backendDb = openBackendDb(":memory:");
    const sendMessage = vi.fn(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
    const bot = { api: { sendMessage } } as unknown as Bot;
    const config = loadConfig({ ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "token", ALERT_COOLDOWN_SECONDS: "3600" });
    try {
      backendDb.sqlite
        .prepare(
          "INSERT INTO post_events(event_type,severity,target,message,created_at) VALUES ('publish.failed','error','x','API unavailable',?)",
        )
        .run(new Date().toISOString());
      expect(await runObservabilityCycle(config, backendDb, bot)).toMatchObject({ alerts: 1 });
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(
        (backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM credential_checks").get() as { count: number }).count,
      ).toBeGreaterThan(10);

      backendDb.sqlite
        .prepare(
          "INSERT INTO post_events(event_type,severity,target,message,created_at) VALUES ('publish.failed','error','x','API unavailable',?)",
        )
        .run(new Date().toISOString());
      expect(await runObservabilityCycle(config, backendDb, bot)).toMatchObject({ alerts: 0 });
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(
        (backendDb.sqlite.prepare("SELECT suppressed_count FROM alert_dedup").get() as { suppressed_count: number }).suppressed_count,
      ).toBe(1);

      backendDb.sqlite
        .prepare(
          "INSERT INTO publish_jobs(post_key,message_id,target,status,locked_at,payload_json,created_at,updated_at) VALUES ('post:stale',1,'threads','publishing','2000-01-01T00:00:00.000Z','{}',?,?)",
        )
        .run(new Date().toISOString(), new Date().toISOString());
      await runObservabilityCycle(config, backendDb, null);
      expect(
        (backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM post_events WHERE event_type='queue.stale'").get() as { count: number })
          .count,
      ).toBe(1);
      await runObservabilityCycle(config, backendDb, null);
      expect(
        (backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM post_events WHERE event_type='queue.stale'").get() as { count: number })
          .count,
      ).toBe(1);
    } finally {
      backendDb.close();
    }
  });
});
