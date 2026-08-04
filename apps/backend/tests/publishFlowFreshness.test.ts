import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { isStaleCardCallback, POST_CARD_FRESHNESS, VIDEO_CARD_FRESHNESS } from "../src/bot/card-freshness.js";
import { handlePostAction } from "../src/bot/post-actions.js";
import { handleVideoActionCallback } from "../src/bot/video-actions.js";
import { getSession } from "../src/bot/video-session.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import type { BackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import {
  setTelegramPostCard,
  setTelegramVideoCard,
  telegramPostCard,
  telegramVideoCard,
} from "../src/interfaces/telegram/control-cards.js";
import { createVideoDraft, replaceVideoTargets } from "../src/publishing/video-service.js";
import { openBackendDb } from "./helpers/open-db.js";

function videoCallback(data: string, messageId: number): Context {
  return {
    from: { id: 42 },
    chat: { id: 100 },
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: async () => undefined,
    editMessageText: async () => undefined,
  } as unknown as Context;
}

describe("video publication card flow", () => {
  it("keeps the immediate confirmation on the current video card", async () => {
    const backendDb: BackendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42" });
      config.studio.modules.video_posting = true;
      config.studio.modules.youtube = true;
      const draftId = createVideoDraft(backendDb, 42, "clip.mp4", 24);
      replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
      setTelegramVideoCard(backendDb, draftId, 100, 10);

      await handleVideoActionCallback(videoCallback(`video_now:${draftId}`, 10), backendDb, config);

      const session = getSession(backendDb, 42);
      expect(session?.step).toBe("schedule_confirm");
      expect(telegramVideoCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: 10 });
      expect(
        isStaleCardCallback(
          videoCallback(`video_now_confirm:${draftId}`, 10),
          backendDb,
          `video_now_confirm:${draftId}`,
          VIDEO_CARD_FRESHNESS,
        ),
      ).toBe(false);
    } finally {
      backendDb.close();
    }
  });
});

describe("post publication card flow", () => {
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
      const context = {
        from: { id: 42 },
        chat: { id: 100 },
        callbackQuery: { data: `publish:${draftId}`, message: { message_id: 10 } },
        answerCallbackQuery: async () => true,
        reply: async () => ({ message_id: ++nextMessageId }),
        replyWithVideo: async () => ({ message_id: ++nextMessageId }),
      } as unknown as Context;

      await handlePostAction(context, backendDb, config);

      expect(telegramPostCard(backendDb, draftId)).toEqual({ chatId: 100, messageId: nextMessageId });
      expect(
        isStaleCardCallback(
          { callbackQuery: { message: { message_id: nextMessageId } } } as unknown as Context,
          backendDb,
          `publish_confirm:${draftId}`,
          POST_CARD_FRESHNESS,
        ),
      ).toBe(false);
    } finally {
      backendDb.close();
    }
  });
});
