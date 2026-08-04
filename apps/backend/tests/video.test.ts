import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { handlePublicationCallback } from "../src/bot/callback-router.js";
import { publicationCallback, versionedCallback } from "../src/bot/session-fsm.js";
import { handleVideoConversationMessage } from "../src/bot/video-conversation.js";
import { getVideoState, saveVideoState } from "../src/bot/video-ui.js";
import {
  drafts,
  socialComments,
  studioMediaAssets,
  videoDrafts,
  videoJobs,
  videoMetricSchedule,
  videoMetricSnapshots,
  videoTargets,
} from "../src/db/schema.js";
import { recoverVideoLocks, runVideoCycle } from "../src/delivery/video-worker.js";
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
import { useBackendDb } from "./helpers/db.js";

const testDb = useBackendDb();

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
  it("selects the video locale before asking for the MP4", async () => {
    const backendDb = testDb.open();
    const session = saveVideoState(backendDb, 42, { draftId: null, step: "locale", selected: [], data: {} });

    expect(
      await handlePublicationCallback(
        videoContext({ callback: versionedCallback(publicationCallback("video", "locale", ["en"]), session.revision) }).context,
        backendDb,
        videoConfig(),
      ),
    ).toBe(true);
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "asset", data: { videoLocale: "en" } });
  });

  it("persists the selected locale and resolves the matching Zernio account", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24, "en");
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    const config = loadConfig({
      PUBLISH_PROVIDER_ROUTES_JSON:
        '{"instagram_reels":{"provider":"zernio","accountId":"ru-account"},"instagram_reels_en":{"provider":"zernio","accountId":"en-account"}}',
      ZERNIO_API_KEY: "z".repeat(16),
    });
    scheduleVideo(
      backendDb,
      draftId,
      { instagram_reels: new Date(Date.now() + 60 * 60_000) },
      { prepareLeadMinutes: 15, reminderMinutes: 5 },
      config,
    );

    expect(backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.id, draftId)).get()?.locale).toBe("en");
    expect(listVideoTargets(backendDb, draftId)[0]).toMatchObject({ deliveryProvider: "zernio", providerAccountId: "en-account" });
  });

  it("removes an expired Studio source after every draft using it is final", async () => {
    const backendDb = testDb.open();
    const directory = mkdtempSync(path.join(os.tmpdir(), "studio-video-retention-"));
    const source = path.join(directory, "source.mp4");
    writeFileSync(source, "video");
    try {
      const now = new Date().toISOString();
      const asset = backendDb.db
        .insert(studioMediaAssets)
        .values({
          actorId: 42,
          kind: "video",
          mimeType: "video/mp4",
          filename: "source.mp4",
          localPath: source,
          byteSize: 5,
          sha256: "a".repeat(64),
          source: "telegram",
          createdAt: now,
        })
        .returning({ id: studioMediaAssets.id })
        .get();
      if (!asset) throw new Error("asset missing");
      const draftId = createVideoDraft(backendDb, 42, { studioMediaAssetId: asset.id }, 24);
      replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
      const target = listVideoTargets(backendDb, draftId)[0];
      if (!target) throw new Error("target missing");
      backendDb.db.update(videoTargets).set({ status: "published", updatedAt: now }).where(eq(videoTargets.id, target.id)).run();
      backendDb.db
        .update(videoDrafts)
        .set({ status: "published", retentionUntil: new Date(Date.now() - 1_000).toISOString(), updatedAt: now })
        .where(eq(videoDrafts.id, draftId))
        .run();

      const config = { ...videoConfig(), STUDIO_MEDIA_DIR: directory, VIDEO_MEDIA_DIR: directory };
      await runVideoCycle(config, backendDb);
      expect(existsSync(source)).toBe(false);
      expect(backendDb.db.select().from(studioMediaAssets).where(eq(studioMediaAssets.id, asset.id)).get()).toBeDefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an expired Studio source that is still attached to a post draft", async () => {
    const backendDb = testDb.open();
    const directory = mkdtempSync(path.join(os.tmpdir(), "studio-video-retention-shared-"));
    const source = path.join(directory, "source.mp4");
    writeFileSync(source, "video");
    try {
      const now = new Date().toISOString();
      const asset = backendDb.db
        .insert(studioMediaAssets)
        .values({
          actorId: 42,
          kind: "video",
          mimeType: "video/mp4",
          filename: "source.mp4",
          localPath: source,
          byteSize: 5,
          sha256: "b".repeat(64),
          source: "telegram",
          createdAt: now,
        })
        .returning({ id: studioMediaAssets.id })
        .get();
      if (!asset) throw new Error("asset missing");
      const draftId = createVideoDraft(backendDb, 42, { studioMediaAssetId: asset.id }, 24);
      replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
      const target = listVideoTargets(backendDb, draftId)[0];
      if (!target) throw new Error("target missing");
      backendDb.db.update(videoTargets).set({ status: "published", updatedAt: now }).where(eq(videoTargets.id, target.id)).run();
      backendDb.db
        .update(videoDrafts)
        .set({ status: "published", retentionUntil: new Date(Date.now() - 1_000).toISOString(), updatedAt: now })
        .where(eq(videoDrafts.id, draftId))
        .run();
      backendDb.db
        .insert(drafts)
        .values({
          actorId: 42,
          status: "needs_review",
          textRu: "Post using the same asset",
          targetsJson: "{}",
          mediaRuJson: JSON.stringify([{ type: "video", asset_id: asset.id, local_path: source }]),
          createdAt: now,
          updatedAt: now,
        })
        .run();

      await runVideoCycle({ ...videoConfig(), STUDIO_MEDIA_DIR: directory, VIDEO_MEDIA_DIR: directory }, backendDb);
      expect(existsSync(source)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("holds a stale video publish lock for verification instead of risking a duplicate", () => {
    const backendDb = testDb.open();
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

    const config = { ...videoConfig(), VIDEO_LOCK_TIMEOUT_SECONDS: 60 };
    expect(recoverVideoLocks(backendDb, config)).toBe(1);
    expect(backendDb.db.select().from(videoJobs).all()).toMatchObject([
      {
        status: "verification_required",
        attemptCount: 1,
        lockedBy: null,
        lockedAt: null,
        lastError: "worker_lost: video lock expired before completion",
      },
    ]);
    expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, target.id)).get()).toMatchObject({
      status: "verification_required",
      lastError: "worker_lost: video lock expired before completion",
    });
  });

  it("still retries a stale native Instagram prepare lock because it cannot have published", () => {
    const backendDb = testDb.open();
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
        kind: "prepare",
        runAt: now,
        status: "running",
        attemptCount: 0,
        lockedBy: "old-worker",
        lockedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(recoverVideoLocks(backendDb, { ...videoConfig(), VIDEO_LOCK_TIMEOUT_SECONDS: 60 })).toBe(1);
    expect(backendDb.db.select().from(videoJobs).all()).toMatchObject([
      { status: "queued", attemptCount: 1, lockedBy: null, lockedAt: null, lastError: "worker_lost: video lock expired before completion" },
    ]);
    expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, target.id)).get()).toMatchObject({
      status: "scheduled",
      lastError: "worker_lost: video lock expired before completion",
    });
  });

  it("updates one video field through the Telegram message state machine", async () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", { title: "Old", description: "Description", tags: [] });
    saveVideoState(backendDb, 42, { draftId, step: "youtube_title", selected: ["youtube_shorts"], data: { is_single_edit: true } });
    const { context } = videoContext({ text: "New title" });

    expect((await handleVideoConversationMessage(context, backendDb, videoConfig())).handled).toBe(true);
    expect(listVideoTargets(backendDb, draftId)[0]?.metadataJson).toMatchObject({ title: "New title" });
    expect(getVideoState(backendDb, 42)).toBeNull();
  });

  it("advances the YouTube+Instagram wizard through every metadata step in FSM order", async () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    saveVideoState(backendDb, 42, { draftId, step: "youtube_title", selected: ["youtube_shorts", "instagram_reels"], data: {} });

    await handleVideoConversationMessage(videoContext({ text: "My Title" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "youtube_description" });

    await handleVideoConversationMessage(videoContext({ text: "My Description" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "youtube_game_url" });

    await handleVideoConversationMessage(videoContext({ text: "-" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "youtube_tags" });

    await handleVideoConversationMessage(videoContext({ text: "a, b, c" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "instagram_caption" });
    expect(listVideoTargets(backendDb, draftId).find((row) => row.target === "youtube_shorts")?.metadataJson).toMatchObject({
      title: "My Title",
      description: "My Description",
      tags: ["a", "b", "c"],
    });

    await handleVideoConversationMessage(videoContext({ text: "Caption #tag" }).context, backendDb, videoConfig());
    expect(getVideoState(backendDb, 42)).toMatchObject({ step: "schedule_choice" });
    expect(listVideoTargets(backendDb, draftId).find((row) => row.target === "instagram_reels")?.metadataJson).toMatchObject({
      caption: "Caption #tag",
    });
  });

  it("routes target selection callbacks and rejects an invalid target", async () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    const session = saveVideoState(backendDb, 42, { draftId, step: "targets", selected: ["youtube_shorts"], data: {} });
    const selected = videoContext({ callback: versionedCallback(publicationCallback("video", "targets_done"), session.revision) });

    expect(await handlePublicationCallback(selected.context, backendDb, videoConfig())).toBe(true);
    expect(getVideoState(backendDb, 42)).toMatchObject({ draftId, step: "youtube_title" });
    expect(listVideoTargets(backendDb, draftId).map((target) => target.target)).toEqual(["youtube_shorts"]);

    const invalidSession = saveVideoState(backendDb, 42, { draftId, step: "targets", selected: ["youtube_shorts"], data: {} });
    const invalid = videoContext({
      callback: versionedCallback(publicationCallback("video", "toggle", ["not-a-target"]), invalidSession.revision),
    });
    expect(await handlePublicationCallback(invalid.context, backendDb, videoConfig())).toBe(true);
    expect(invalid.callbackAnswers).toEqual([{ text: "Start creating the video again." }]);
  });

  it("keeps independent platform schedules and queues Delivery prepare and publish work", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const youtubeAt = new Date(Date.now() + 60 * 60_000);
    const instagramAt = new Date(Date.now() + 2 * 60 * 60_000);
    scheduleVideo(
      backendDb,
      draftId,
      { youtube_shorts: youtubeAt, instagram_reels: instagramAt },
      { prepareLeadMinutes: 15, reminderMinutes: 5 },
      videoConfig(),
      24,
    );

    expect(listVideoTargets(backendDb, draftId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "youtube_shorts",
          scheduledAt: youtubeAt.toISOString(),
          metadataJson: expect.objectContaining({ videoDurationMs: 24_000 }),
        }),
        expect.objectContaining({
          target: "instagram_reels",
          scheduledAt: instagramAt.toISOString(),
          metadataJson: expect.objectContaining({ videoDurationMs: 24_000 }),
        }),
      ]),
    );
    expect(backendDb.sqlite.prepare("SELECT kind, count(*) AS count FROM video_jobs GROUP BY kind ORDER BY kind").all()).toEqual([
      { kind: "prepare", count: 2 },
      { kind: "publish", count: 2 },
    ]);
  });

  it("snapshots the Zernio route and account on a scheduled Instagram target", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    const config = loadConfig({
      ZERNIO_API_KEY: "a".repeat(16),
      PUBLISH_PROVIDER_ROUTES_JSON: '{"instagram_reels":{"provider":"zernio","accountId":"maru-account"}}',
    });
    scheduleVideo(
      backendDb,
      draftId,
      { instagram_reels: new Date(Date.now() + 60 * 60_000) },
      { prepareLeadMinutes: 15, reminderMinutes: 5 },
      config,
    );
    expect(listVideoTargets(backendDb, draftId)[0]).toMatchObject({ deliveryProvider: "zernio", providerAccountId: "maru-account" });
  });

  it("retains a cancelled source for at least the configured 24 hours", () => {
    const backendDb = testDb.open();
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

  it("refuses cancellation while delivery is running and leaves every target untouched", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const targets = listVideoTargets(backendDb, draftId);
    const youtube = targets.find((target) => target.target === "youtube_shorts");
    const instagram = targets.find((target) => target.target === "instagram_reels");
    if (!youtube || !instagram) throw new Error("video targets missing");
    const now = new Date().toISOString();
    backendDb.db
      .update(videoTargets)
      .set({ status: "published", externalUrl: "https://www.youtube.com/watch?v=published", publishedAt: now, updatedAt: now })
      .where(eq(videoTargets.id, youtube.id))
      .run();
    backendDb.db
      .insert(videoJobs)
      .values({
        videoDraftId: draftId,
        videoTargetId: instagram.id,
        kind: "publish",
        runAt: now,
        status: "running",
        lockedBy: "worker-1",
        lockedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(() => cancelVideo(backendDb, draftId, 24)).toThrow("err.video-cancel-in-progress");
    expect(backendDb.db.select().from(videoJobs).all()).toMatchObject([{ status: "running", lockedBy: "worker-1", lockedAt: now }]);
    expect(listVideoTargets(backendDb, draftId).map((target) => ({ target: target.target, status: target.status }))).toEqual([
      { target: "youtube_shorts", status: "published" },
      { target: "instagram_reels", status: "editing" },
    ]);
  });

  it("does not let another admin remove a video platform", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const service = videoService(backendDb, videoConfig());

    expect(() => service.removeTarget(7, draftId, "youtube_shorts")).toThrow("err.video-not-yours");
    expect(listVideoTargets(backendDb, draftId)).toHaveLength(2);
    expect(service.removeTarget(42, draftId, "youtube_shorts")).toEqual({ cancelled: false });
    expect(listVideoTargets(backendDb, draftId).map((target) => target.target)).toEqual(["instagram_reels"]);
  });

  it("refuses to reschedule a platform whose publish job a worker is still holding", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["instagram_reels"]);
    const initial = new Date(Date.now() + 60 * 60_000);
    scheduleVideo(backendDb, draftId, { instagram_reels: initial }, { prepareLeadMinutes: 15, reminderMinutes: 5 }, videoConfig());
    backendDb.db
      .update(videoJobs)
      .set({ status: "running", lockedBy: "worker-1", lockedAt: new Date().toISOString() })
      .where(and(eq(videoJobs.videoDraftId, draftId), eq(videoJobs.kind, "publish")))
      .run();

    // Clearing the lock here would break the worker's (id, lockedBy) fence and
    // let the requeued job publish the same target a second time.
    expect(() =>
      scheduleVideo(
        backendDb,
        draftId,
        { instagram_reels: new Date(Date.now() + 3 * 60 * 60_000) },
        { prepareLeadMinutes: 15, reminderMinutes: 5 },
        videoConfig(),
      ),
    ).toThrow("err.video-job-running");
    expect(
      backendDb.db
        .select()
        .from(videoJobs)
        .where(and(eq(videoJobs.videoDraftId, draftId), eq(videoJobs.kind, "publish")))
        .get(),
    ).toMatchObject({ status: "running", lockedBy: "worker-1" });
    expect(listVideoTargets(backendDb, draftId)[0]?.scheduledAt).toBe(initial.toISOString());
  });

  it("reschedules only the selected platform and never requeues a published target", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
    const initial = new Date(Date.now() + 60 * 60_000);
    scheduleVideo(
      backendDb,
      draftId,
      { youtube_shorts: initial, instagram_reels: new Date(initial.getTime() + 60 * 60_000) },
      { prepareLeadMinutes: 15, reminderMinutes: 5 },
      videoConfig(),
    );
    backendDb.db
      .update(videoTargets)
      .set({ status: "published" })
      .where(and(eq(videoTargets.videoDraftId, draftId), eq(videoTargets.target, "youtube_shorts")))
      .run();

    const instagramAt = new Date(Date.now() + 3 * 60 * 60_000);
    scheduleVideo(backendDb, draftId, { instagram_reels: instagramAt }, { prepareLeadMinutes: 15, reminderMinutes: 5 }, videoConfig());

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
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    scheduleVideo(
      backendDb,
      draftId,
      { youtube_shorts: new Date(Date.now() + 60 * 60_000) },
      { prepareLeadMinutes: 15, reminderMinutes: 5 },
      videoConfig(),
    );
    expect(() => replaceVideoTargets(backendDb, draftId, ["instagram_reels"])).toThrow("err.video-targets-locked");
    expect(listVideoTargets(backendDb, draftId).map((target) => target.target)).toEqual(["youtube_shorts"]);
  });

  it("cleans dependent analytics rows when editable targets are replaced", () => {
    const backendDb = testDb.open();
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
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    const row = backendDb.sqlite.prepare("SELECT status, retention_until FROM video_drafts WHERE id=?").get(draftId) as {
      status: string;
      retention_until: string;
    };
    expect(row.status).toBe("editing");
    expect(new Date(row.retention_until).getTime()).toBeGreaterThanOrEqual(Date.now() + 23 * 60 * 60_000);
  });

  it("shows separate YouTube and Instagram metadata on the control card", () => {
    const backendDb = testDb.open();
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

    const preview = videoPreview(videoService(backendDb, videoConfig()).preview(42, draftId), videoConfig(), "ru");
    expect(preview.text).toContain("▶️ *YouTube Shorts*");
    expect(preview.text).toContain("Название: Название ролика");
    expect(preview.text).toContain("Игра: https://store.steampowered.com/app/123");
    expect(preview.text).toContain("📸 *Instagram Reels*");
    expect(preview.text).toContain("Описание: Описание для Instagram");
  });

  it("retries only a failed platform without touching the other target", () => {
    const backendDb = testDb.open();
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
