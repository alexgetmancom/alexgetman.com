import { afterEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../src/db/client.js";
import { openBackendDb } from "../src/db/client.js";
import { videoTargets } from "../src/db/schema.js";
import {
  cancelVideo,
  createVideoDraft,
  listVideoTargets,
  replaceVideoTargets,
  retryFailedVideoTarget,
  saveVideoMetadata,
  scheduleVideo,
  videoPreview,
} from "../src/video/service.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("video publication queue", () => {
  it("keeps independent platform schedules and queues prepare, reminder and publish work", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const youtubeAt = new Date(Date.now() + 60 * 60_000);
    const instagramAt = new Date(Date.now() + 2 * 60 * 60_000);
    scheduleVideo(
      backendDb,
      draftId,
      { youtube_shorts: youtubeAt, instagram_reels: instagramAt },
      { prepareLeadMinutes: 15, reminderMinutes: 5 },
    );

    expect(listVideoTargets(backendDb, draftId).map((row) => ({ target: row.target, scheduledAt: row.scheduledAt }))).toEqual([
      { target: "youtube_shorts", scheduledAt: youtubeAt.toISOString() },
      { target: "instagram_reels", scheduledAt: instagramAt.toISOString() },
    ]);
    expect(backendDb.sqlite.prepare("SELECT kind, count(*) AS count FROM video_jobs GROUP BY kind ORDER BY kind").all()).toEqual([
      { kind: "prepare", count: 2 },
      { kind: "publish", count: 2 },
      { kind: "reminder", count: 2 },
    ]);
  });

  it("retains a cancelled source for at least the configured 24 hours", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    cancelVideo(backendDb, draftId, 24);
    const row = backendDb.sqlite.prepare("SELECT status, retention_until FROM video_drafts WHERE id=?").get(draftId) as {
      status: string;
      retention_until: string;
    };
    expect(row.status).toBe("cancelled");
    expect(new Date(row.retention_until).getTime()).toBeGreaterThanOrEqual(Date.now() + 23 * 60 * 60_000);
  });

  it("sets a 24-hour retention deadline as soon as a draft video is uploaded", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    const row = backendDb.sqlite.prepare("SELECT status, retention_until FROM video_drafts WHERE id=?").get(draftId) as {
      status: string;
      retention_until: string;
    };
    expect(row.status).toBe("editing");
    expect(new Date(row.retention_until).getTime()).toBeGreaterThanOrEqual(Date.now() + 23 * 60 * 60_000);
  });

  it("shows separate YouTube and Instagram metadata on the control card", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", {
      title: "Название ролика",
      description: "Описание для YouTube",
      gameUrl: "https://store.steampowered.com/app/123",
      tags: ["game", "shorts"],
    });
    saveVideoMetadata(backendDb, draftId, "instagram_reels", {
      caption: "Описание для Instagram\n#game #reels",
    });

    const preview = videoPreview(backendDb, draftId);
    expect(preview.text).toContain("▶️ *YouTube Shorts*");
    expect(preview.text).toContain("Название: Название ролика");
    expect(preview.text).toContain("Игра: https://store.steampowered.com/app/123");
    expect(preview.text).toContain("📸 *Instagram Reels*");
    expect(preview.text).toContain("Описание: Описание для Instagram");
  });

  it("retries only a failed platform without touching the other target", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const instagram = backendDb.db
      .select()
      .from(videoTargets)
      .where(and(eq(videoTargets.videoDraftId, draftId), eq(videoTargets.target, "instagram_reels")))
      .get();
    if (!instagram) throw new Error("instagram target missing");
    backendDb.db.update(videoTargets).set({ status: "failed", lastError: "Meta failed" }).where(eq(videoTargets.id, instagram.id)).run();

    retryFailedVideoTarget(backendDb, draftId, "instagram_reels");

    expect(backendDb.sqlite.prepare("SELECT status FROM video_targets WHERE id=?").get(instagram.id)).toEqual({ status: "scheduled" });
    expect(
      backendDb.sqlite.prepare("SELECT count(*) AS count FROM video_jobs WHERE video_target_id=? AND kind='prepare'").get(instagram.id),
    ).toEqual({ count: 1 });
    expect(
      backendDb.sqlite.prepare("SELECT status FROM video_targets WHERE video_draft_id=? AND target='youtube_shorts'").get(draftId),
    ).toEqual({ status: "editing" });
  });
});
