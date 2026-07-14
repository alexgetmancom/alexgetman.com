import { describe, expect, it } from "bun:test";
import { openBackendDb } from "../src/db/client.js";
import { drafts, publishJobs, videoDrafts, videoTargets } from "../src/db/schema.js";
import { queueService } from "../src/studio/services/queue.js";

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
            adminId: 7,
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
            adminId: 7,
            status: "needs_review",
            textRu: "Черновик поста",
            targetsJson: "{}",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 3,
            adminId: 8,
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
        .values({ adminId: 7, assetKey: "video", label: "Черновик видео", status: "editing", createdAt: now, updatedAt: now })
        .returning({ id: videoDrafts.id })
        .get();
      if (!video) throw new Error("video draft missing");
      backendDb.db
        .insert(videoTargets)
        .values({ videoDraftId: video.id, target: "youtube_shorts", metadataJson: {}, status: "draft", createdAt: now, updatedAt: now })
        .run();

      const snapshot = queueService(backendDb).snapshot(7);
      expect(snapshot.upcoming).toHaveLength(1);
      expect(snapshot.upcoming[0]?.label).toBe("Запланированный пост");
      expect(snapshot.drafts.map((item) => item.label)).toEqual(["Черновик поста", "Черновик видео"]);
      expect(snapshot.attention).toEqual([{ id: 1, label: "Запланированный пост", kind: "post" }]);
    } finally {
      backendDb.close();
    }
  });
});
