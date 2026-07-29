import { describe, expect, it } from "bun:test";
import type { Bot } from "grammy";
import { openBackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { sendWeeklyAnalyticsSummary } from "../src/interfaces/telegram/analytics-summary.js";
import { settingsService } from "../src/studio/services/settings.js";

describe("weekly analytics summary", () => {
  it("uses one Studio-wide setting, sends to every administrator, and does not require video posting", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42,7" });
      settingsService(backendDb).setWeeklyDigest({ enabled: true, weekday: 1 });
      const sent: number[] = [];
      const bot = {
        api: {
          sendMessage: async (actorId: number) => {
            sent.push(actorId);
          },
        },
      } as unknown as Bot;
      const mondayAfterNine = new Date("2026-07-27T18:05:00.000Z");

      expect(await sendWeeklyAnalyticsSummary(config, backendDb, bot, mondayAfterNine)).toBe(true);
      expect(sent).toEqual([42, 7]);
      expect(await sendWeeklyAnalyticsSummary(config, backendDb, bot, mondayAfterNine)).toBe(false);
      expect(sent).toEqual([42, 7]);
    } finally {
      backendDb.close();
    }
  });

  it("waits until 21:00 in the Studio timezone", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42" });
      settingsService(backendDb).setWeeklyDigest({ weekday: 1 });
      const bot = { api: { sendMessage: async () => undefined } } as unknown as Bot;

      expect(await sendWeeklyAnalyticsSummary(config, backendDb, bot, new Date("2026-07-27T17:59:00.000Z"))).toBe(false);
    } finally {
      backendDb.close();
    }
  });
});
