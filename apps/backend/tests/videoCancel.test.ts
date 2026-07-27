import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../src/db/client.js";
import { postEvents, studioNotificationJobs, videoTargets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { createVideoDraft, replaceVideoTargets } from "../src/publishing/video-service.js";
import { videoService } from "../src/studio/services/videos.js";
import { useBackendDb } from "./helpers/db.js";

/**
 * Cancelling a video is the undo for a publication, and it is the one place
 * where two already-tested pieces are composed: cancelVideo decides what has to
 * be held or removed by hand (video.test.ts), keepYouTubeUploadPrivate performs
 * the hold (videoPublishers.test.ts). What is only here is what happens between
 * them — that one failing hold does not abandon the rest, and that the operator
 * is told, because a YouTube upload left scheduled-public after a cancellation
 * goes live on its own.
 *
 * As in videoWorker.test.ts, `mock.module` is process-wide, so the replacement
 * delegates to the real function unless this file is the one running.
 */
let intercepting = false;
const publishers = await import("../src/delivery/video-publishers.js");
const realKeepPrivate = publishers.keepYouTubeUploadPrivate;

const held: string[] = [];
let failFor: Set<string> = new Set();

mock.module("../src/delivery/video-publishers.js", () => ({
  ...publishers,
  keepYouTubeUploadPrivate: async (...args: Parameters<typeof realKeepPrivate>) => {
    if (!intercepting) return realKeepPrivate(...args);
    const [, videoId] = args;
    if (failFor.has(videoId)) throw new Error(`youtube rejected ${videoId}`);
    held.push(videoId);
  },
}));

const config = loadConfig({ ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "token", VIDEO_MEDIA_RETENTION_HOURS: "24" });
const testDb = useBackendDb();

beforeAll(() => {
  intercepting = true;
});
afterAll(() => {
  intercepting = false;
});

function setup(backendDb: BackendDb): number {
  held.length = 0;
  failFor = new Set();
  const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
  replaceVideoTargets(backendDb, draftId, ["youtube_shorts", "instagram_reels"]);
  return draftId;
}

/** A YouTube upload that already exists on the platform but is still scheduled
 * for a future time — the only shape cancelVideo asks to be held private. */
function scheduledYouTube(backendDb: BackendDb, draftId: number, externalId: string): void {
  const now = new Date().toISOString();
  backendDb.db
    .update(videoTargets)
    .set({ externalId, scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(), status: "scheduled", updatedAt: now })
    .where(and(eq(videoTargets.videoDraftId, draftId), eq(videoTargets.target, "youtube_shorts")))
    .run();
}

function publishedInstagram(backendDb: BackendDb, draftId: number): void {
  const now = new Date().toISOString();
  backendDb.db
    .update(videoTargets)
    .set({ status: "published", externalUrl: "https://instagram.com/reel/1", publishedAt: now, updatedAt: now })
    .where(and(eq(videoTargets.videoDraftId, draftId), eq(videoTargets.target, "instagram_reels")))
    .run();
}

/** post_events.details_json is a TEXT column holding a JSON string. */
function eventDetails(event: { detailsJson?: string | null } | undefined): Record<string, unknown> {
  return JSON.parse(event?.detailsJson ?? "{}") as Record<string, unknown>;
}

function cancellationEvents(backendDb: BackendDb, draftId: number) {
  return backendDb.db
    .select()
    .from(postEvents)
    .where(and(eq(postEvents.postKey, `video:${draftId}`), eq(postEvents.eventType, "studio.notification.video_cancelled")))
    .all();
}

describe("videoService.cancel", () => {
  it("holds every scheduled YouTube upload private and reports them back", async () => {
    const backendDb = testDb.open();
    const draftId = setup(backendDb);
    scheduledYouTube(backendDb, draftId, "yt-scheduled");

    const result = await videoService(backendDb, config).cancel(42, draftId);

    expect(held).toEqual(["yt-scheduled"]);
    expect(result).toMatchObject({ heldPrivateYouTubeIds: ["yt-scheduled"], holdFailures: [] });
  });

  it("keeps holding the remaining uploads after one of them fails", async () => {
    const backendDb = testDb.open();
    const draftId = setup(backendDb);
    scheduledYouTube(backendDb, draftId, "yt-broken");
    // A second draft supplies the second id: one draft carries one YouTube
    // target, and the point here is the loop, not the schema.
    const second = createVideoDraft(backendDb, 42, "video-source-2", 24);
    replaceVideoTargets(backendDb, second, ["youtube_shorts"]);
    scheduledYouTube(backendDb, second, "yt-ok");
    failFor = new Set(["yt-broken"]);

    const first = await videoService(backendDb, config).cancel(42, draftId);
    const rest = await videoService(backendDb, config).cancel(42, second);

    expect(first).toMatchObject({ heldPrivateYouTubeIds: [], holdFailures: ["youtube rejected yt-broken"] });
    expect(rest).toMatchObject({ heldPrivateYouTubeIds: ["yt-ok"], holdFailures: [] });
    expect(held).toEqual(["yt-ok"]);
  });

  it("records a warning when a hold failed, so a still-public upload is not silent", async () => {
    const backendDb = testDb.open();
    const draftId = setup(backendDb);
    scheduledYouTube(backendDb, draftId, "yt-broken");
    failFor = new Set(["yt-broken"]);

    await videoService(backendDb, config).cancel(42, draftId);

    const [event] = cancellationEvents(backendDb, draftId);
    expect(event).toMatchObject({ severity: "warn" });
    expect(String(event?.message)).toContain("YouTube schedule needs attention");
    expect(eventDetails(event)).toMatchObject({ hold_failures: ["youtube rejected yt-broken"] });
  });

  it("records an informational note when only manual removal is left", async () => {
    const backendDb = testDb.open();
    const draftId = setup(backendDb);
    publishedInstagram(backendDb, draftId);

    const result = await videoService(backendDb, config).cancel(42, draftId);

    const [event] = cancellationEvents(backendDb, draftId);
    expect(event).toMatchObject({ severity: "info" });
    expect(String(event?.message)).toContain("require manual removal");
    expect(eventDetails(event)).toMatchObject({
      manual_removal: [{ target: "instagram_reels", url: "https://instagram.com/reel/1" }],
    });
    expect(result).toMatchObject({ holdFailures: [] });
  });

  it("stays quiet when nothing was published and every hold succeeded", async () => {
    const backendDb = testDb.open();
    const draftId = setup(backendDb);
    scheduledYouTube(backendDb, draftId, "yt-scheduled");

    await videoService(backendDb, config).cancel(42, draftId);

    // An event here would page the operator about a cancellation that needs
    // nothing from them.
    expect(cancellationEvents(backendDb, draftId)).toEqual([]);
  });

  it("cancels the draft's queued reminders along with it", async () => {
    const backendDb = testDb.open();
    const draftId = setup(backendDb);
    const now = new Date().toISOString();
    backendDb.db
      .insert(studioNotificationJobs)
      .values([
        { actorId: 42, ref: `video:${draftId}`, kind: "video.reminder", runAt: now, status: "queued", createdAt: now, updatedAt: now },
        { actorId: 42, ref: "video:999", kind: "video.reminder", runAt: now, status: "queued", createdAt: now, updatedAt: now },
      ])
      .run();

    await videoService(backendDb, config).cancel(42, draftId);

    const jobs = backendDb.db.select().from(studioNotificationJobs).all();
    expect(jobs.find((job) => job.ref === `video:${draftId}`)?.status).toBe("cancelled");
    // Another video's reminders are not this cancellation's business.
    expect(jobs.find((job) => job.ref === "video:999")?.status).toBe("queued");
  });

  it("refuses a draft that belongs to someone else before touching YouTube", async () => {
    const backendDb = testDb.open();
    const draftId = setup(backendDb);
    scheduledYouTube(backendDb, draftId, "yt-scheduled");

    await expect(videoService(backendDb, config).cancel(7, draftId)).rejects.toThrow();
    expect(held).toEqual([]);
    expect(
      backendDb.db
        .select()
        .from(videoTargets)
        .all()
        .every((target) => target.status !== "cancelled"),
    ).toBe(true);
  });
});
