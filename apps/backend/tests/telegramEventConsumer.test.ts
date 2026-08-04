import { describe, expect, it, mock } from "bun:test";
import type { Bot } from "grammy";
import { botUiSettings, drafts, publishJobs, siteJobs, videoDrafts, videoTargets } from "../src/db/schema.js";
import { recordDomainEvent } from "../src/domain/events.js";
import { loadConfig } from "../src/foundation/config.js";
import { setTelegramVideoCard } from "../src/interfaces/telegram/control-cards.js";
import { consumeTelegramEvents } from "../src/interfaces/telegram/event-consumer.js";
import { refreshVideoControlCard, sendStudioCompletion, sendStudioReminder } from "../src/interfaces/telegram/video-notifications.js";
import { withDb } from "./helpers/db.js";

const config = loadConfig({ ADMIN_IDS: "42" });

function milestone(message: string) {
  return { type: "analytics.milestone.reached", severity: "info" as const, message };
}

describe("Telegram event consumer", () => {
  it("refreshes a video card in its owner's stored UI locale", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db.insert(botUiSettings).values({ actorId: 42, locale: "en", updatedAt: now }).run();
      backendDb.db
        .insert(videoDrafts)
        .values({
          id: 11,
          actorId: 42,
          locale: "en",
          label: "Shared launch",
          assetKey: "asset",
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(videoTargets)
        .values({ videoDraftId: 11, target: "youtube_shorts", metadataJson: {}, status: "draft", createdAt: now, updatedAt: now })
        .run();
      setTelegramVideoCard(backendDb, 11, 42, 100);
      const edits: string[] = [];
      const editMessageText = mock(async (_chatId: number, _messageId: number, text: string) => void edits.push(text));
      const bot = { api: { editMessageText } } as unknown as Bot;

      await refreshVideoControlCard(backendDb, bot, { TIMEZONE: "UTC", TIMEZONE_LABEL: "UTC" }, 11);

      expect(edits[0]).toContain("Status:");
      expect(edits[0]).not.toContain("Статус:");
    }));

  it("drops an undeliverable event instead of blocking every event behind it", async () =>
    withDb(async (backendDb) => {
      recordDomainEvent(backendDb.events, milestone("first"));
      recordDomainEvent(backendDb.events, milestone("second"));
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
      recordDomainEvent(backendDb.events, milestone("only"));
      const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    }));

  it("fans one aggregated video reminder and detailed completion out to every admin", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(videoDrafts)
        .values({
          id: 10,
          actorId: 42,
          locale: "en",
          label: "Shared launch",
          assetKey: "asset",
          status: "published",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(videoTargets)
        .values([
          { videoDraftId: 10, target: "youtube_shorts", metadataJson: {}, status: "published", createdAt: now, updatedAt: now },
          { videoDraftId: 10, target: "instagram_reels", metadataJson: {}, status: "published", createdAt: now, updatedAt: now },
        ])
        .run();
      const sendMessage = mock(async (chatId: number, text: string, options: unknown) => ({
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: "private" as const },
        text,
        options,
      }));
      const bot = { api: { sendMessage } } as unknown as Bot;
      const sharedConfig = loadConfig({ ADMIN_IDS: "42,7" });

      await sendStudioReminder(backendDb, bot, sharedConfig, {
        postKey: "video:10",
        detailsJson: {
          actor_id: 42,
          title: "Shared launch",
          targets: ["youtube_shorts", "instagram_reels"],
          minutes: 5,
          publish_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      });
      await sendStudioCompletion(backendDb, bot, sharedConfig, {
        postKey: "video:10",
        detailsJson: { total: 2, published: 2, failed: 0 },
      });

      expect(sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([42, 7, 42, 7]);
      for (const call of sendMessage.mock.calls.slice(0, 2)) {
        expect(call[1]).toContain("YouTube Shorts");
        expect(call[1]).toContain("Instagram Reels");
        expect(call[1]).toContain("🇬🇧 EN");
      }
      for (const call of sendMessage.mock.calls.slice(2)) {
        expect(call[1]).toContain("✅ YouTube Shorts");
        expect(call[1]).toContain("✅ Instagram Reels");
      }
    }));

  it("sends one actionable aggregate for a failed post and does not replay it", async () =>
    withDb(async (backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(drafts)
        .values({
          id: 11,
          actorId: 42,
          status: "failed",
          textRu: "Failed post",
          targetsJson: JSON.stringify({ telegram_ru: true, site_en: true }),
          postId: 110,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 110,
          postKey: "post:110",
          messageId: 110,
          target: "telegram_ru",
          status: "failed",
          lastError: "Telegram timed out",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({
          postId: 110,
          messageId: 110,
          reason: "publish_en",
          status: "published",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      recordDomainEvent(backendDb.events, {
        ref: "post:110",
        type: "delivery.post.completed",
        severity: "info",
        message: "Post #110 completed with 1 failed target(s)",
        details: { post_id: 110, total: 2, published: 1, failed: 1 },
      });
      const sendMessage = mock(async (chatId: number, text: string, options: unknown) => ({
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: "private" as const },
        text,
        options,
      }));
      const bot = { api: { sendMessage } } as unknown as Bot;

      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]?.[1]).toContain("Telegram");
      expect(sendMessage.mock.calls[0]?.[1]).toContain("Telegram timed out");
      expect(JSON.stringify(sendMessage.mock.calls[0]?.[2])).toContain("p:post:post_retry_notice:11");
      expect(JSON.stringify(sendMessage.mock.calls[0]?.[2])).toContain("p:post:preview:11");
      expect(await consumeTelegramEvents(backendDb, bot, config)).toBe(0);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    }));
});
