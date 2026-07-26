import { describe, expect, it, mock } from "bun:test";
import type { Bot } from "grammy";
import { recordDomainEvent } from "../src/domain/events.js";
import { loadConfig } from "../src/foundation/config.js";
import { consumeTelegramEvents } from "../src/interfaces/telegram/event-consumer.js";
import { withDb } from "./helpers/db.js";

const config = loadConfig({ ADMIN_IDS: "42" });

function milestone(message: string) {
  return { type: "analytics.milestone.reached", severity: "info" as const, message };
}

describe("Telegram event consumer", () => {
  it("drops an undeliverable event instead of blocking every event behind it", async () =>
    withDb(async (backendDb) => {
      recordDomainEvent(backendDb, milestone("first"));
      recordDomainEvent(backendDb, milestone("second"));
      // Telegram's real failure here is a 403 from a user who blocked the bot:
      // permanent, chat-specific, and no reason to stall the whole queue.
      const sendMessage = mock(async (_chatId: number, text: string) => {
        if (text === "first") throw new Error("Forbidden: bot was blocked by the user");
        return { message_id: 1, date: 1, chat: { id: 42, type: "private" as const } };
      });
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
      expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual(["first", "second"]);

      // Both are marked delivered: the failed one is not retried on the next tick.
      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    }));

  it("delivers each event exactly once across repeated ticks", async () =>
    withDb(async (backendDb) => {
      recordDomainEvent(backendDb, milestone("only"));
      const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    }));
});
