import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { type Context, InlineKeyboard } from "grammy";
import { handlePublicationCallback } from "../src/bot/callback-router.js";
import { isStaleCardCallback, POST_CARD_FRESHNESS, VIDEO_CARD_FRESHNESS } from "../src/bot/card-freshness.js";
import { editDraftPreview, showScheduleConfirmation } from "../src/bot/post-card.js";
import { publicationCallback, versionedCallback } from "../src/bot/session-fsm.js";
import { getVideoState, sendVideoControl } from "../src/bot/video-ui.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import type { BackendDb } from "../src/db/client.js";
import { draftStoryCards, videoDrafts } from "../src/db/schema.js";
import { unsafeDb } from "../src/db/unsafe.js";
import { loadConfig } from "../src/foundation/config.js";
import {
  setTelegramPostCard,
  setTelegramVideoCard,
  telegramPostCard,
  telegramVideoCard,
} from "../src/interfaces/telegram/control-cards.js";
import { createVideoDraft, replaceVideoTargets } from "../src/publishing/video-service.js";
import { openBackendDb } from "./helpers/open-db.js";

function callbackContext(messageId: number): Context {
  return { callbackQuery: { message: { message_id: messageId } } } as unknown as Context;
}

function postAction(action: string, args: readonly (string | number)[] = []): string {
  return publicationCallback("post", action, args);
}

function videoAction(action: string, args: readonly (string | number)[] = []): string {
  return publicationCallback("video", action, args);
}

describe("Telegram card freshness", () => {
  it("rejects a mutation from a replaced post card but allows the current one", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      setTelegramPostCard(backendDb, 7, 100, 20);
      expect(isStaleCardCallback(callbackContext(19), backendDb, postAction("publish", [7]), POST_CARD_FRESHNESS)).toBe(true);
      expect(isStaleCardCallback(callbackContext(20), backendDb, postAction("publish", [7]), POST_CARD_FRESHNESS)).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, publicationCallback("post", "publish", [7]), POST_CARD_FRESHNESS)).toBe(
        true,
      );
      expect(isStaleCardCallback(callbackContext(19), backendDb, postAction("preview", [7]), POST_CARD_FRESHNESS)).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, postAction("threads_chain", [7]), POST_CARD_FRESHNESS)).toBe(true);
      expect(isStaleCardCallback(callbackContext(20), backendDb, postAction("threads_chain", [7]), POST_CARD_FRESHNESS)).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, postAction("story_schedule_all", [7]), POST_CARD_FRESHNESS)).toBe(true);
      expect(isStaleCardCallback(callbackContext(20), backendDb, postAction("story_schedule_all", [7]), POST_CARD_FRESHNESS)).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("tracks the publish confirmation card after delivery previews", async () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42" });
      const draftId = createDraftFromMessage(backendDb, 42, {
        text: "Video post",
        textEn: "Video post",
        entities: [],
        media: [{ type: "video", file_id: "video-1" }],
      });
      setTelegramPostCard(backendDb, draftId, 100, 10);
      let nextMessageId = 10;
      const context = (data: string, messageId: number): Context =>
        ({
          from: { id: 42 },
          chat: { id: 100 },
          callbackQuery: { data, message: { message_id: messageId } },
          answerCallbackQuery: async () => true,
          reply: async () => ({ message_id: ++nextMessageId }),
          replyWithVideo: async () => ({ message_id: ++nextMessageId }),
        }) as unknown as Context;

      await handlePublicationCallback(context(postAction("publish", [draftId]), 10), backendDb, config);

      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 17 });
      expect(
        isStaleCardCallback(
          context(postAction("publish_confirm", [draftId]), 17),
          backendDb,
          postAction("publish_confirm", [draftId]),
          POST_CARD_FRESHNESS,
        ),
      ).toBe(false);
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

      await handlePublicationCallback(context(postAction("schedule", [draftId]), 10), backendDb, config);
      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 11 });

      await handlePublicationCallback(context(postAction("story_schedule_all", [draftId]), 11), backendDb, config);
      await handlePublicationCallback(context(postAction("sched_scope", [draftId, "both"]), 11), backendDb, config);
      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 11 });
    } finally {
      backendDb.close();
    }
  });

  it("rejects a mutation from a replaced video card", () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      setTelegramVideoCard(backendDb, 7, 100, 20);
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoAction("schedule", [7]), VIDEO_CARD_FRESHNESS)).toBe(true);
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoAction("sched_pick", [7, "2100"]), VIDEO_CARD_FRESHNESS)).toBe(true);
      expect(isStaleCardCallback(callbackContext(20), backendDb, videoAction("schedule", [7]), VIDEO_CARD_FRESHNESS)).toBe(false);
      // Retry callbacks are also emitted by failure notifications, which are
      // separate messages from the current card. The service validates the
      // target state, so this action does not need card freshness protection.
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoAction("retry", [7, "youtube_shorts"]), VIDEO_CARD_FRESHNESS)).toBe(
        false,
      );
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoAction("cancel_notice", [7]), VIDEO_CARD_FRESHNESS)).toBe(false);
      expect(isStaleCardCallback(callbackContext(19), backendDb, videoAction("open", [7]), VIDEO_CARD_FRESHNESS)).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("rebases the durable video card when a scheduling prompt becomes a new message", async () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const draftId = unsafeDb(backendDb)
        .db.insert(videoDrafts)
        .values({ actorId: 42, locale: "ru", assetKey: "clip.mp4", status: "editing", createdAt: now, updatedAt: now })
        .returning({ id: videoDrafts.id })
        .get()?.id;
      if (!draftId) throw new Error("video draft missing");
      const ctx = {
        chat: { id: 100 },
        reply: async () => ({ message_id: 21 }),
      } as unknown as Context;

      await sendVideoControl(
        ctx,
        backendDb,
        42,
        { kind: "video", draftId, step: "schedule_common", selected: ["youtube_shorts"], data: {}, controlMessageId: null, revision: 0 },
        "When?",
        new InlineKeyboard(),
      );

      expect(telegramVideoCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 21 });
    } finally {
      backendDb.close();
    }
  });

  it("keeps a two-platform video schedule on the latest Telegram control message", async () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42" });
      config.studio.modules.video_posting = true;
      config.studio.modules.youtube = true;
      config.studio.modules.instagram = true;
      const draftId = createVideoDraft(backendDb, 42, "clip.mp4", 24);
      replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
      setTelegramVideoCard(backendDb, draftId, 100, 10);
      let nextMessageId = 20;
      const context = (data: string, messageId: number): Context =>
        ({
          from: { id: 42 },
          chat: { id: 100 },
          callbackQuery: { data, message: { message_id: messageId } },
          answerCallbackQuery: async () => true,
          editMessageText: async () => undefined,
          reply: async () => ({ message_id: ++nextMessageId }),
          api: { editMessageText: async () => undefined },
        }) as unknown as Context;

      await handlePublicationCallback(context(videoAction("schedule", [draftId]), 10), backendDb, config);
      const choice = getVideoState(backendDb, 42);
      if (!choice) throw new Error("video schedule session missing");
      await handlePublicationCallback(context(versionedCallback(videoAction("common", [draftId]), choice.revision), 10), backendDb, config);
      const timePrompt = getVideoState(backendDb, 42);
      if (!timePrompt) throw new Error("video time session missing");
      expect(telegramVideoCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 21 });

      await handlePublicationCallback(
        context(versionedCallback(videoAction("sched_pick", [draftId, "0800"]), timePrompt.revision), 21),
        backendDb,
        config,
      );

      expect(getVideoState(backendDb, 42)?.step).toBe("schedule_confirm");
      expect(telegramVideoCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 24 });
      expect(
        isStaleCardCallback(
          context(videoAction("schedule_confirm", [draftId]), 21),
          backendDb,
          videoAction("schedule_confirm", [draftId]),
          VIDEO_CARD_FRESHNESS,
        ),
      ).toBe(true);
      expect(
        isStaleCardCallback(
          context(videoAction("schedule_confirm", [draftId]), 24),
          backendDb,
          videoAction("schedule_confirm", [draftId]),
          VIDEO_CARD_FRESHNESS,
        ),
      ).toBe(false);
    } finally {
      backendDb.close();
    }
  });
});
