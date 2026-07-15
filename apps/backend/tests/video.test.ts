import { afterEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { handleVideoCallback, handleVideoMessage } from "../src/bot/video-screen.js";
import { getSession, saveSession } from "../src/bot/video-session.js";
import type { BackendDb } from "../src/db/client.js";
import { openBackendDb } from "../src/db/client.js";
import { socialComments, videoJobs, videoMetricSchedule, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";
import { recoverVideoLocks } from "../src/delivery/video-worker.js";
import { loadConfig } from "../src/foundation/config.js";
import { videoPreview } from "../src/interfaces/telegram/video-preview.js";
import { listVideoTargets } from "../src/publishing/video-data.js";
import {
  cancelVideo,
  createVideoDraft,
  replaceVideoTargets,
  retryFailedVideoTarget,
  saveVideoMetadata,
  scheduleVideo,
} from "../src/publishing/video-service.js";
import { videoService } from "../src/studio/services/videos.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

function videoConfig() {
  const config = loadConfig({});
  config.studio.modules.video_posting = true;
  config.studio.modules.youtube = true;
  config.studio.modules.instagram = true;
  return config;
}

function videoContext(input: { text?: string; callback?: string } = {}) {
  const replies: string[] = [];
  const callbackAnswers: Array<Record<string, unknown> | undefined> = [];
  const context = {
    from: { id: 42 },
    chat: { id: 100 },
    message: input.text == null ? undefined : { text: input.text },
    callbackQuery: input.callback == null ? undefined : { data: input.callback, message: { message_id: 11 } },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 12 };
    },
    answerCallbackQuery: async (options?: Record<string, unknown>) => {
      callbackAnswers.push(options);
    },
    editMessageReplyMarkup: async () => undefined,
    editMessageText: async () => undefined,
    api: { editMessageText: async () => undefined },
  };
  return { context: context as unknown as import("grammy").Context, replies, callbackAnswers };
}

describe("video publication queue", () => {
  it("fails a stale video lock instead of requeueing an external publication", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    const target = listVideoTargets(backendDb, draftId)[0];
    if (!target) throw new Error("target missing");
    const now = new Date().toISOString();
    backendDb.db
      .insert(videoJobs)
      .values({
        videoDraftId: draftId,
        videoTargetId: target.id,
        kind: "publish",
        runAt: now,
        status: "running",
        lockedBy: "old-worker",
        lockedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(recoverVideoLocks(backendDb, 60, 24)).toBe(1);
    expect(backendDb.db.select().from(videoJobs).all()).toMatchObject([
      { status: "failed", lockedBy: null, lockedAt: null, lastError: "stale video lock requires manual retry" },
    ]);
    expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, target.id)).get()).toMatchObject({
      status: "failed",
      lastError: "stale video lock requires manual retry",
    });
  });

  it("updates one video field through the Telegram message state machine", async () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", { title: "Old", description: "Description", tags: [] });
    saveSession(backendDb, 42, { draftId, step: "youtube_title", selected: ["youtube_shorts"], data: { is_single_edit: true } });
    const { context } = videoContext({ text: "New title" });

    expect(await handleVideoMessage(context, backendDb, videoConfig())).toBe(true);
    expect(listVideoTargets(backendDb, draftId)[0]?.metadataJson).toMatchObject({ title: "New title" });
    expect(getSession(backendDb, 42)).toBeNull();
  });

  it("routes target selection callbacks and rejects an invalid target", async () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    saveSession(backendDb, 42, { draftId, step: "targets", selected: ["youtube_shorts"], data: {} });
    const selected = videoContext({ callback: "video_targets_done" });

    expect(await handleVideoCallback(selected.context, backendDb, videoConfig())).toBe(true);
    expect(getSession(backendDb, 42)).toMatchObject({ draftId, step: "youtube_title" });
    expect(listVideoTargets(backendDb, draftId).map((target) => target.target)).toEqual(["youtube_shorts"]);

    const invalid = videoContext({ callback: "video_toggle:not-a-target" });
    expect(await handleVideoCallback(invalid.context, backendDb, videoConfig())).toBe(true);
    expect(invalid.callbackAnswers).toEqual([{ text: "Начните создание видео заново." }]);
  });

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
    expect(backendDb.sqlite.prepare("SELECT status FROM video_targets WHERE video_draft_id=?").all(draftId)).toEqual([
      { status: "cancelled" },
    ]);
  });

  it("does not let another admin remove a video platform", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const service = videoService(backendDb, videoConfig());

    expect(() => service.removeTarget(7, draftId, "youtube_shorts")).toThrow("not available");
    expect(listVideoTargets(backendDb, draftId)).toHaveLength(2);
    expect(service.removeTarget(42, draftId, "youtube_shorts")).toEqual({ cancelled: false });
    expect(listVideoTargets(backendDb, draftId).map((target) => target.target)).toEqual(["instagram_reels"]);
  });

  it("reschedules only the selected platform and never requeues a published target", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const initial = new Date(Date.now() + 60 * 60_000);
    scheduleVideo(
      backendDb,
      draftId,
      { youtube_shorts: initial, instagram_reels: new Date(initial.getTime() + 60 * 60_000) },
      { prepareLeadMinutes: 15, reminderMinutes: 5 },
    );
    backendDb.db
      .update(videoTargets)
      .set({ status: "published" })
      .where(and(eq(videoTargets.videoDraftId, draftId), eq(videoTargets.target, "youtube_shorts")))
      .run();

    const instagramAt = new Date(Date.now() + 3 * 60 * 60_000);
    scheduleVideo(backendDb, draftId, { instagram_reels: instagramAt }, { prepareLeadMinutes: 15, reminderMinutes: 5 });

    expect(
      listVideoTargets(backendDb, draftId).map((target) => ({
        target: target.target,
        status: target.status,
        scheduledAt: target.scheduledAt,
      })),
    ).toEqual([
      { target: "youtube_shorts", status: "published", scheduledAt: initial.toISOString() },
      { target: "instagram_reels", status: "scheduled", scheduledAt: instagramAt.toISOString() },
    ]);
  });

  it("does not replace video targets once scheduling has begun", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    scheduleVideo(
      backendDb,
      draftId,
      { youtube_shorts: new Date(Date.now() + 60 * 60_000) },
      { prepareLeadMinutes: 15, reminderMinutes: 5 },
    );

    expect(() => replaceVideoTargets(backendDb!, draftId, ["instagram_reels"])).toThrow("only before scheduling");
    expect(listVideoTargets(backendDb, draftId).map((target) => target.target)).toEqual(["youtube_shorts"]);
  });

  it("cleans dependent analytics rows when editable targets are replaced", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    const target = listVideoTargets(backendDb, draftId)[0];
    if (!target) throw new Error("target missing");
    const now = new Date().toISOString();
    backendDb.db
      .insert(videoMetricSnapshots)
      .values({ videoTargetId: target.id, platform: "youtube_shorts", metricsJson: {}, sampledAt: now })
      .run();
    backendDb.db.insert(videoMetricSchedule).values({ videoTargetId: target.id, nextCheckAt: now, updatedAt: now }).run();
    backendDb.db
      .insert(socialComments)
      .values({ platform: "youtube", commentId: "comment", videoTargetId: target.id, text: "x", fetchedAt: now })
      .run();

    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);

    expect(backendDb.db.select().from(videoMetricSnapshots).all()).toHaveLength(0);
    expect(backendDb.db.select().from(videoMetricSchedule).all()).toHaveLength(0);
    expect(backendDb.db.select().from(socialComments).all()).toHaveLength(0);
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
