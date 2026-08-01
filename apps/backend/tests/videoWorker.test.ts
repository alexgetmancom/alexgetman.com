import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { videoJobs, videoTargets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { createVideoDraft, replaceVideoTargets, saveVideoMetadata, scheduleVideo } from "../src/publishing/video-service.js";
import { useBackendDb } from "./helpers/db.js";

/**
 * The video cycle's job execution: which platform call a job makes, what it
 * writes back to the durable target, and what it does when the draft is
 * cancelled underneath a running upload.
 *
 * The publishers themselves are covered by videoPublishers.test.ts; here they
 * are replaced so a cycle can be driven end to end without uploading. As in
 * socialPorts.test.ts, `mock.module` is process-wide, so the replacements
 * delegate to the real functions unless this file is the one running.
 */

let intercepting = false;
const publishers = await import("../src/delivery/video-publishers.js");
const zernio = await import("../src/delivery/zernio.js");
const real = {
  prepareYouTubeVideo: publishers.prepareYouTubeVideo,
  keepYouTubeUploadPrivate: publishers.keepYouTubeUploadPrivate,
  prepareInstagramReel: publishers.prepareInstagramReel,
  instagramContainerReady: publishers.instagramContainerReady,
  publishInstagramReel: publishers.publishInstagramReel,
  publishZernioInstagramReel: zernio.publishZernioInstagramReel,
};

const seen: string[] = [];
const instagramCredentialsSeen: Array<{ token: string | undefined; userId: string | undefined }> = [];
let containerReadyError: Error | null = null;
/** Runs while a platform call is in flight, so a test can cancel the draft
 * exactly where a real cancellation would land. */
let duringUpload: (() => void) | null = null;

mock.module("../src/delivery/video-publishers.js", () => ({
  ...publishers,
  prepareYouTubeVideo: async (...args: Parameters<typeof real.prepareYouTubeVideo>) => {
    if (!intercepting) return real.prepareYouTubeVideo(...args);
    seen.push("prepareYouTubeVideo");
    duringUpload?.();
    return { id: "yt-1", url: "https://www.youtube.com/watch?v=yt-1" };
  },
  keepYouTubeUploadPrivate: async (...args: Parameters<typeof real.keepYouTubeUploadPrivate>) => {
    if (!intercepting) return real.keepYouTubeUploadPrivate(...args);
    seen.push("keepYouTubeUploadPrivate");
  },
  prepareInstagramReel: async (...args: Parameters<typeof real.prepareInstagramReel>) => {
    if (!intercepting) return real.prepareInstagramReel(...args);
    seen.push("prepareInstagramReel");
    instagramCredentialsSeen.push({ token: args[0].INSTAGRAM_ACCESS_TOKEN, userId: args[0].INSTAGRAM_USER_ID });
    duringUpload?.();
    return { id: "ig-container" };
  },
  instagramContainerReady: async (...args: Parameters<typeof real.instagramContainerReady>) => {
    if (!intercepting) return real.instagramContainerReady(...args);
    seen.push("instagramContainerReady");
    instagramCredentialsSeen.push({ token: args[0].INSTAGRAM_ACCESS_TOKEN, userId: args[0].INSTAGRAM_USER_ID });
    if (containerReadyError) throw containerReadyError;
  },
  publishInstagramReel: async (...args: Parameters<typeof real.publishInstagramReel>) => {
    if (!intercepting) return real.publishInstagramReel(...args);
    seen.push("publishInstagramReel");
    instagramCredentialsSeen.push({ token: args[0].INSTAGRAM_ACCESS_TOKEN, userId: args[0].INSTAGRAM_USER_ID });
    return { id: "ig-reel", url: "https://www.instagram.com/reel/ig-reel/" };
  },
}));
mock.module("../src/delivery/zernio.js", () => ({
  ...zernio,
  publishZernioInstagramReel: async (...args: Parameters<typeof real.publishZernioInstagramReel>) => {
    if (!intercepting) return real.publishZernioInstagramReel(...args);
    seen.push("publishZernioInstagramReel");
    return { providerPostId: "z-1", externalId: "ig-2", url: "https://www.instagram.com/reel/ig-2/" };
  },
}));

const { runVideoCycle } = await import("../src/delivery/video-worker.js");
const { cancelVideo } = await import("../src/publishing/video-service.js");

const testDb = useBackendDb();

beforeAll(() => {
  intercepting = true;
});
afterAll(() => {
  intercepting = false;
});

function videoConfig(directory: string, overrides: Record<string, string> = {}) {
  const config = loadConfig({
    YOUTUBE_CLIENT_ID: "client",
    YOUTUBE_CLIENT_SECRET: "secret",
    YOUTUBE_REFRESH_TOKEN: "refresh",
    INSTAGRAM_ACCESS_TOKEN: "EAAB-token",
    INSTAGRAM_USER_ID: "ig-user",
    PUBLIC_MEDIA_BASE_URL: "https://alexgetman.com/media",
    ...overrides,
  });
  config.studio.modules.video_posting = true;
  config.studio.modules.youtube = true;
  config.studio.modules.instagram = true;
  return { ...config, VIDEO_MEDIA_DIR: directory, STUDIO_MEDIA_DIR: directory };
}

/** A scheduled draft whose jobs are all due now, so one cycle runs them. */
function dueDraft(
  backendDb: ReturnType<typeof testDb.open>,
  directory: string,
  targets: string[],
  config: ReturnType<typeof videoConfig>,
  locale: "ru" | "en" = "ru",
): number {
  // A draft references its source by asset key; videoPath resolves it as
  // `<key>.<ext>` inside VIDEO_MEDIA_DIR.
  const assetKey = `clip-${targets.join("-")}`;
  writeFileSync(path.join(directory, `${assetKey}.mp4`), "video-bytes");
  const draftId = createVideoDraft(backendDb, 42, assetKey, 24, locale);
  replaceVideoTargets(backendDb, draftId, targets as never);
  if (targets.includes("youtube_shorts")) {
    saveVideoMetadata(backendDb, draftId, "youtube_shorts", {
      title: "Test video",
      description: "Test description",
      tags: [],
    });
  }
  const at = new Date(Date.now() + 60 * 60_000);
  scheduleVideo(
    backendDb,
    draftId,
    Object.fromEntries(targets.map((target) => [target, at])),
    {
      prepareLeadMinutes: 15,
      reminderMinutes: 5,
    },
    config,
  );
  // Drizzle needs a predicate to update; the point here is only to make every
  // job of this draft due, so drive it through the raw handle.
  const past = new Date(Date.now() - 1_000).toISOString();
  backendDb.sqlite.prepare("UPDATE video_jobs SET run_at = ?, updated_at = ? WHERE video_draft_id = ?").run(past, past, draftId);
  return draftId;
}

function targetRow(backendDb: ReturnType<typeof testDb.open>, draftId: number) {
  return backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
}

function withDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "video-worker-"));
  return fn(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function reset(): void {
  seen.length = 0;
  instagramCredentialsSeen.length = 0;
  containerReadyError = null;
  duringUpload = null;
}

describe("video job execution", () => {
  it("uploads to YouTube on prepare and records the id before the scheduled release", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"], config);

      await runVideoCycle(config, backendDb);

      expect(seen).toContain("prepareYouTubeVideo");
      const target = targetRow(backendDb, draftId);
      // Publishing is a second job: prepare only parks a private upload.
      expect(target).toMatchObject({ status: "published", externalId: "yt-1", externalUrl: "https://www.youtube.com/watch?v=yt-1" });
    });
  });

  it("keeps a cancelled YouTube upload private instead of leaking it", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"], config);
      // The video id exists only in the upload response, so a cancellation
      // arriving mid-flight must fence it before the state is discarded.
      duringUpload = () => cancelVideo(backendDb, draftId, 24);

      await runVideoCycle(config, backendDb);

      expect(seen).toContain("keepYouTubeUploadPrivate");
      expect(targetRow(backendDb, draftId)?.status).toBe("cancelled");
      expect(targetRow(backendDb, draftId)?.externalId).toBeNull();
    });
  });

  it("creates an Instagram container on prepare and publishes it once it is ready", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"], config);

      await runVideoCycle(config, backendDb);

      expect(seen).toEqual(["prepareInstagramReel", "instagramContainerReady", "publishInstagramReel"]);
      expect(targetRow(backendDb, draftId)).toMatchObject({
        status: "published",
        externalId: "ig-reel",
        externalUrl: "https://www.instagram.com/reel/ig-reel/",
      });
    });
  });

  it("uses the draft locale's native Instagram credentials for an English Reel", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory, {
        INSTAGRAM_EN_ACCESS_TOKEN: "en-token",
        INSTAGRAM_EN_USER_ID: "en-user",
      });
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"], config, "en");

      await runVideoCycle(config, backendDb);

      expect(targetRow(backendDb, draftId)?.status).toBe("published");
      expect(instagramCredentialsSeen).toEqual([
        { token: "en-token", userId: "en-user" },
        { token: "en-token", userId: "en-user" },
        { token: "en-token", userId: "en-user" },
      ]);
    });
  });

  it("leaves the target prepared and retryable while the container is still processing", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"], config);
      containerReadyError = new publishers.InstagramContainerProcessingError("Instagram container IN_PROGRESS");

      await runVideoCycle(config, backendDb);

      expect(seen).not.toContain("publishInstagramReel");
      expect(targetRow(backendDb, draftId)?.status).toBe("prepared");
      // The publish job must survive for the next cycle rather than dead-end.
      const job = backendDb.db.select().from(videoJobs).where(eq(videoJobs.kind, "publish")).get();
      expect(job?.status).toBe("queued");
      expect(job?.lastError).toContain("IN_PROGRESS");
    });
  });

  it("routes a Zernio target to the provider instead of the Graph API", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory, {
        ZERNIO_API_KEY: "z".repeat(16),
        PUBLISH_PROVIDER_ROUTES_JSON: '{"instagram_reels":{"provider":"zernio","accountId":"maru-account"}}',
      });
      const draftId = dueDraft(backendDb, directory, ["instagram_reels"], config);

      await runVideoCycle(config, backendDb);

      // Prepare is a local checkpoint for Zernio: publishing early would break
      // the schedule the creator chose.
      expect(seen).toEqual(["publishZernioInstagramReel"]);
      expect(targetRow(backendDb, draftId)).toMatchObject({ status: "published", providerPostId: "z-1", externalId: "ig-2" });
    });
  });

  it("fails the job rather than publishing when the source file is gone", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"], config);
      rmSync(path.join(directory, "clip-youtube_shorts.mp4"), { force: true });

      await runVideoCycle(config, backendDb);

      expect(seen).toHaveLength(0);
      expect(targetRow(backendDb, draftId)?.status).not.toBe("published");
      const job = backendDb.db.select().from(videoJobs).where(eq(videoJobs.kind, "prepare")).get();
      expect(job?.lastError).toContain("Video source was removed");
    });
  });

  it("records a reminder without touching any platform", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"], config);
      // Only the reminder should run: scheduling creates prepare and publish
      // jobs, and a reminder is queued separately.
      backendDb.sqlite.prepare("DELETE FROM video_jobs").run();
      const past = new Date(Date.now() - 1_000).toISOString();
      backendDb.sqlite
        .prepare(
          "INSERT INTO video_jobs (video_draft_id, kind, status, run_at, attempt_count, created_at, updated_at) VALUES (?,'reminder','queued',?,0,?,?)",
        )
        .run(draftId, past, past, past);

      await runVideoCycle(config, backendDb);

      expect(seen).toHaveLength(0);
      const events = backendDb.sqlite.prepare("SELECT event_type FROM post_events WHERE post_key = ?").all(`video:${draftId}`) as {
        event_type: string;
      }[];
      expect(events.map((event) => event.event_type)).toContain("video.reminder.due");
    });
  });

  it("does nothing for a target that was already cancelled before the cycle", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      const draftId = dueDraft(backendDb, directory, ["youtube_shorts"], config);
      cancelVideo(backendDb, draftId, 24);

      await runVideoCycle(config, backendDb);

      expect(seen).toHaveLength(0);
    });
  });

  it("stays idle while the video module is switched off", async () => {
    reset();
    await withDirectory(async (directory) => {
      const backendDb = testDb.open();
      const config = videoConfig(directory);
      dueDraft(backendDb, directory, ["youtube_shorts"], config);
      const disabled = { ...config, studio: { ...config.studio, modules: { ...config.studio.modules, video_posting: false } } };

      expect(await runVideoCycle(disabled, backendDb)).toBe(0);
      expect(seen).toHaveLength(0);
    });
  });
});
