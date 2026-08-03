import { describe, expect, it } from "bun:test";
import { queueText } from "../src/bot/queue.js";
import { drafts, publishJobs, videoDrafts, videoTargets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import type { StudioQueueSnapshot } from "../src/studio/services/queue.js";
import { queueService } from "../src/studio/services/queue.js";
import { openBackendDb } from "./helpers/open-db.js";

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
      const video = backendDb.db
        .insert(videoDrafts)
        .values({ actorId: 7, assetKey: "video", label: "Черновик видео", status: "editing", createdAt: now, updatedAt: now })
        .returning({ id: videoDrafts.id })
        .get();
      if (!video) throw new Error("video draft missing");
      backendDb.db
        .insert(videoTargets)
        .values({ videoDraftId: video.id, target: "youtube_shorts", metadataJson: {}, status: "draft", createdAt: now, updatedAt: now })
        .run();

      const snapshot = queueService(backendDb, loadConfig({ ADMIN_IDS: "7,8" })).snapshot(7);
      expect(snapshot.upcoming).toHaveLength(1);
      expect(snapshot.upcoming[0]?.label).toBe("Запланированный пост");
      expect(snapshot.drafts.map((item) => item.label)).toEqual(["Чужой черновик", "Черновик поста", "Черновик видео"]);
      expect(snapshot.attention).toEqual([{ id: 1, label: "Запланированный пост", kind: "post" }]);
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
            assetKey: `published-${index}`,
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
          assetKey: "scheduled-video",
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

      const snapshot = queueService(backendDb, loadConfig({ ADMIN_IDS: "7" })).snapshot(7);
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

      const snapshot = queueService(backendDb, loadConfig({ ADMIN_IDS: "7" })).snapshot(7);
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

    const text = queueText(snapshot, "ru", "Europe/Moscow");
    expect(text).toContain("Ближайшие публикации");
    expect(text).toContain("Scheduled clip");
    expect(text).toContain("Черновики (1)");
  });
});
