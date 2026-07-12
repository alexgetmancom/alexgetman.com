import { afterEach, describe, expect, it } from "bun:test";
import type { BackendDb } from "../src/db/client.js";
import { openBackendDb } from "../src/db/client.js";
import { cancelVideo, createVideoDraft, listVideoTargets, replaceVideoTargets, scheduleVideo } from "../src/video/service.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("video publication queue", () => {
  it("keeps independent platform schedules and queues prepare, reminder and publish work", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source");
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
    const draftId = createVideoDraft(backendDb, 42, "video-source");
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    cancelVideo(backendDb, draftId, 24);
    const row = backendDb.sqlite.prepare("SELECT status, retention_until FROM video_drafts WHERE id=?").get(draftId) as {
      status: string;
      retention_until: string;
    };
    expect(row.status).toBe("cancelled");
    expect(new Date(row.retention_until).getTime()).toBeGreaterThanOrEqual(Date.now() + 23 * 60 * 60_000);
  });
});
