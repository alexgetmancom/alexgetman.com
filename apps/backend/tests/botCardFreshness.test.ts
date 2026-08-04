import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Context } from "grammy";
import { isStalePostCardCallback, isStaleVideoCardCallback } from "../src/bot/card-freshness.js";
import { handlePostAction } from "../src/bot/post-actions.js";
import { editDraftPreview, showScheduleConfirmation } from "../src/bot/post-card.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import type { BackendDb } from "../src/db/client.js";
import { draftStoryCards } from "../src/db/schema.js";
import { unsafeDb } from "../src/db/unsafe.js";
import { loadConfig } from "../src/foundation/config.js";
import { setTelegramPostCard, setTelegramVideoCard, telegramPostCard } from "../src/interfaces/telegram/control-cards.js";
import { openBackendDb } from "./helpers/open-db.js";

function callbackContext(messageId: number): Context {
  return { callbackQuery: { message: { message_id: messageId } } } as unknown as Context;
}

describe("Telegram card freshness", () => {
  it("rejects a mutation from a replaced post card but allows the current one", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      setTelegramPostCard(backendDb, 7, 100, 20);
      expect(isStalePostCardCallback(callbackContext(19), backendDb, "publish", 7)).toBe(true);
      expect(isStalePostCardCallback(callbackContext(20), backendDb, "publish", 7)).toBe(false);
      expect(isStalePostCardCallback(callbackContext(19), backendDb, "preview", 7)).toBe(false);
      expect(isStalePostCardCallback(callbackContext(19), backendDb, "story_schedule_all", 7)).toBe(true);
      expect(isStalePostCardCallback(callbackContext(20), backendDb, "story_schedule_all", 7)).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("tracks the message that now renders an inline post screen", async () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Card", textEn: "Card", entities: [], media: [] });
      const ctx = {
        from: { id: 42 },
        chat: { id: 100 },
        callbackQuery: { message: { message_id: 20 } },
        answerCallbackQuery: async () => true,
        editMessageText: async () => undefined,
      } as unknown as Context;

      await editDraftPreview(ctx, backendDb, draftId, loadConfig({}), "schedule");

      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 20 });
    } finally {
      backendDb.close();
    }
  });

  it("tracks a new manual schedule confirmation message", async () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Card", textEn: "Card", entities: [], media: [] });
      const ctx = {
        from: { id: 42 },
        chat: { id: 100 },
        reply: async () => ({ message_id: 21 }),
      } as unknown as Context;

      await showScheduleConfirmation(
        ctx,
        backendDb,
        draftId,
        loadConfig({}),
        new Date("2026-08-05T08:00:00.000Z"),
        null,
        "sched_manual_confirm:1",
      );

      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 21 });
    } finally {
      backendDb.close();
    }
  });

  it("keeps the Story scheduling flow on the message that renders its next screen", async () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42" });
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Card", textEn: "Card", entities: [], media: [] });
      for (const locale of ["ru", "en"] as const) {
        unsafeDb(backendDb)
          .db.update(draftStoryCards)
          .set({ status: "ready", localPath: `/tmp/draft-${draftId}-${locale}.jpg` })
          .where(and(eq(draftStoryCards.draftId, draftId), eq(draftStoryCards.locale, locale)))
          .run();
      }
      setTelegramPostCard(backendDb, draftId, 100, 10);

      const context = (data: string, messageId: number): Context =>
        ({
          from: { id: 42 },
          chat: { id: 100 },
          callbackQuery: { data, message: { message_id: messageId } },
          answerCallbackQuery: async () => true,
          editMessageText: async () => undefined,
          reply: async () => ({ message_id: 11 }),
          replyWithPhoto: async () => ({ message_id: 12 }),
        }) as unknown as Context;

      await handlePostAction(context(`schedule:${draftId}`, 10), backendDb, config);
      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 11 });

      await handlePostAction(context(`story_schedule_all:${draftId}`, 11), backendDb, config);
      await handlePostAction(context(`sched_scope:both:${draftId}`, 11), backendDb, config);
      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 11 });
    } finally {
      backendDb.close();
    }
  });

  it("rejects a mutation from a replaced video card", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      setTelegramVideoCard(backendDb, 7, 100, 20);
      expect(isStaleVideoCardCallback(callbackContext(19), backendDb, "video_schedule:7")).toBe(true);
      expect(isStaleVideoCardCallback(callbackContext(19), backendDb, "video_sched_pick:2100:7")).toBe(true);
      expect(isStaleVideoCardCallback(callbackContext(20), backendDb, "video_schedule:7")).toBe(false);
      expect(isStaleVideoCardCallback(callbackContext(19), backendDb, "video_open:7")).toBe(false);
    } finally {
      backendDb.close();
    }
  });
});
