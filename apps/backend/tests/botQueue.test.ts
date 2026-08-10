import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { queueScreen, showQueue } from "../src/bot/queue.js";
import { draftStoryCards, drafts, publishJobs, videoDrafts, videoTargets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import type { StudioQueueSnapshot } from "../src/studio/services/queue.js";
import { queueService } from "../src/studio/services/queue.js";
import { registerTestChannels } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { createTestVideoAsset } from "./helpers/video.js";

describe("Telegram work queue", () => {
  it("separates upcoming work, unfinished drafts and actual failed targets", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      backendDb.db
        .insert(drafts)
        .values([
          {
            id: 1,
            actorId: 7,
            status: "scheduled",
            textRu: "Запланированный пост",
            targetsJson: JSON.stringify({ telegram_ru: true, telegram_en: true }),
            scheduledAt,
            postId: 101,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 2,
            actorId: 7,
            status: "needs_review",
            textRu: "Черновик поста",
            targetsJson: "{}",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 3,
            actorId: 8,
            status: "needs_review",
            textRu: "Чужой черновик",
            targetsJson: "{}",
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 101,
          postKey: "post:101",
          messageId: 101,
          target: "telegram_ru",
          status: "failed",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(draftStoryCards)
        .values({
          draftId: 1,
          locale: "ru",
          sourceHash: "failed-card",
          headline: "Failed card",
          status: "failed",
          templateVersion: "test",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const video = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 7,
          studioMediaAssetId: createTestVideoAsset(backendDb, 7),
          label: "Черновик видео",
          status: "editing",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: videoDrafts.id })
        .get();
      if (!video) throw new Error("video draft missing");
      backendDb.db
        .insert(videoTargets)
        .values({ videoDraftId: video.id, target: "youtube_shorts", metadataJson: {}, status: "draft", createdAt: now, updatedAt: now })
        .run();

      const snapshot = queueService(backendDb, loadConfig({ CONTROLLER_ADMIN_IDS: "7,8" })).snapshot(7);
      expect(snapshot.upcoming).toHaveLength(1);
      expect(snapshot.upcoming[0]?.label).toBe("Запланированный пост");
      expect(snapshot.drafts.map((item) => item.label)).toEqual(["Чужой черновик", "Черновик поста", "Черновик видео"]);
      expect(snapshot.attention).toEqual([{ id: 1, label: "Запланированный пост", kind: "post", time: new Date(now) }]);
    } finally {
      backendDb.close();
    }
  });

  it("keeps recent scheduled videos visible after the queue history exceeds its cap", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(videoDrafts)
        .values(
          Array.from({ length: 100 }, (_, index) => ({
            actorId: 7,
            studioMediaAssetId: createTestVideoAsset(backendDb, 7),
            label: `Published video ${index}`,
            status: "published",
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const scheduled = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 7,
          studioMediaAssetId: createTestVideoAsset(backendDb, 7),
          label: "Recent scheduled video",
          status: "scheduled",
          scheduledAt,
          createdAt: now,
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        })
        .returning({ id: videoDrafts.id })
        .get();
      if (!scheduled) throw new Error("scheduled video missing");
      backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: scheduled.id,
          target: "youtube_shorts",
          metadataJson: {},
          status: "scheduled",
          scheduledAt,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const snapshot = queueService(backendDb, loadConfig({ CONTROLLER_ADMIN_IDS: "7" })).snapshot(7);
      expect(snapshot.upcoming).toEqual([
        expect.objectContaining({ id: scheduled.id, label: "Recent scheduled video", kind: "video", targets: 1 }),
      ]);
    } finally {
      backendDb.close();
    }
  });

  it("keeps a partially scheduled post actionable instead of showing a past time as upcoming", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      registerTestChannels(backendDb, ["telegram", "threads_en"]);
      const now = new Date().toISOString();
      const ruAt = new Date(Date.now() + 60 * 60_000).toISOString();
      backendDb.db
        .insert(drafts)
        .values({
          actorId: 7,
          status: "scheduled",
          textRu: "RU already handled",
          targetsJson: JSON.stringify({ telegram: true, threads_en: true }),
          scheduledAt: new Date(Date.now() - 60_000).toISOString(),
          scheduledEnAt: null,
          postId: 201,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const futureDraft = backendDb.db
        .insert(drafts)
        .values({
          actorId: 7,
          status: "scheduled",
          textRu: "RU then EN",
          targetsJson: JSON.stringify({ telegram: true, threads_en: true }),
          scheduledAt: ruAt,
          scheduledEnAt: null,
          postId: 202,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      void futureDraft;

      const snapshot = queueService(backendDb, loadConfig({ CONTROLLER_ADMIN_IDS: "7" })).snapshot(7);
      expect(snapshot.upcoming).toHaveLength(0);
      expect(snapshot.drafts.map((item) => item.label)).toEqual(["⏳ RU then EN", "⏳ RU already handled"]);
    } finally {
      backendDb.close();
    }
  });

  it("renders upcoming work and drafts on the same queue screen", () => {
    const snapshot: StudioQueueSnapshot = {
      upcoming: [
        {
          id: 187,
          label: "Scheduled clip",
          time: new Date("2026-08-04T22:02:00.000Z"),
          kind: "video",
          targets: 2,
        },
      ],
      drafts: [{ id: 188, label: "Unfinished clip", time: new Date("2026-08-03T20:35:00.000Z"), kind: "video", targets: 0 }],
      attention: [],
    };

    const { text } = queueScreen(snapshot, "ru", "Europe/Moscow");
    expect(text).toContain("Ближайшие публикации");
    expect(text).toContain("Scheduled clip");
    expect(text).toContain("Черновики (1)");
  });

  it("renders failed work as an actionable attention section", () => {
    const snapshot: StudioQueueSnapshot = {
      upcoming: [],
      drafts: [],
      attention: [{ id: 12, label: "Failed clip", kind: "video", time: new Date() }],
    };

    const { text } = queueScreen(snapshot, "ru", "Europe/Moscow");
    expect(text).toContain("Требует внимания (1)");
    expect(text).not.toContain("Failed clip");
  });

  it("escapes Markdown in queue labels", () => {
    const snapshot: StudioQueueSnapshot = {
      upcoming: [],
      drafts: [{ id: 12, label: "*Draft* [with] _markup_", kind: "post", time: new Date(), targets: 0 }],
      attention: [],
    };

    expect(queueScreen(snapshot, "en", "Europe/Moscow").text).toContain("\\*Draft\\* \\[with\\] \\_markup\\_");
  });

  it("keeps a queue label well-formed when truncation reaches an emoji", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      backendDb.db
        .insert(drafts)
        .values({
          actorId: 7,
          status: "needs_review",
          textRu: `${"x".repeat(37)}😀 after the limit`,
          targetsJson: "{}",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const label = queueService(backendDb, loadConfig({ CONTROLLER_ADMIN_IDS: "7" })).snapshot(7).drafts[0]?.label;
      expect(label).toBe(`${"x".repeat(37)}😀`);
      expect(label).not.toMatch(/[\uD800-\uDFFF]/u);
    } finally {
      backendDb.close();
    }
  });

  it("keeps the inline queue button well-formed after label truncation", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date().toISOString();
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 7,
          studioMediaAssetId: createTestVideoAsset(backendDb, 7),
          label: `${"x".repeat(29)}${"😀".repeat(9)}`,
          status: "scheduled",
          scheduledAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: videoDrafts.id })
        .get();
      if (!draft) throw new Error("video draft missing");
      backendDb.db
        .insert(videoTargets)
        .values({
          videoDraftId: draft.id,
          target: "youtube_shorts",
          metadataJson: {},
          status: "scheduled",
          scheduledAt,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      let options: { reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> } } | undefined;
      const ctx = {
        from: { id: 7 },
        chat: { id: 100 },
        callbackQuery: { message: { message_id: 9 } },
        api: {
          editMessageText: async (_chatId: number, _messageId: number, _text: string, nextOptions: typeof options) => {
            options = nextOptions;
          },
        },
      } as unknown as Context;

      await showQueue(ctx, backendDb, loadConfig({ CONTROLLER_ADMIN_IDS: "7" }));
      const buttonText = options?.reply_markup?.inline_keyboard?.[0]?.[0]?.text;
      expect(buttonText).toBeTruthy();
      encodeURIComponent(buttonText ?? "");
    } finally {
      backendDb.close();
    }
  });

  it("paginates every queue section without dropping items", () => {
    const snapshot: StudioQueueSnapshot = {
      upcoming: Array.from({ length: 11 }, (_, index) => ({
        id: index + 1,
        label: `Upcoming ${index + 1}`,
        kind: "post",
        targets: 1,
        time: new Date(Date.now() + (index + 1) * 60_000),
      })),
      attention: [],
      drafts: [],
    };

    expect(queueScreen(snapshot, "en", "Europe/Moscow").pages).toBe(2);
    expect(queueScreen(snapshot, "en", "Europe/Moscow", 1).text).toContain("Upcoming 11");
    expect(queueScreen(snapshot, "en", "Europe/Moscow", 1).text).toContain("Page 2 of 2");
  });
});
