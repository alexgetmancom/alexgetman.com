import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { studioMediaAssets, studioNotificationJobs, videoJobs, videoTargets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { createVideoDraft, replaceVideoTargets } from "../src/publishing/video-service.js";
import { videoService } from "../src/studio/services/videos.js";
import { withDb } from "./helpers/db.js";

type VideoFixture = {
  config: ReturnType<typeof loadConfig>;
  directory: string;
  draftId: number;
};

let fixtureSequence = 0;

function fixture(backendDb: UnsafeBackendDb, targets = ["instagram_reels"]): VideoFixture {
  const directory = mkdtempSync(join(import.meta.dir, "video-service-boundary-"));
  const source = join(directory, "clip.mp4");
  copyFileSync(join(import.meta.dir, "../../web/public/media/26.mp4"), source);
  const now = new Date().toISOString();
  const asset = backendDb.db
    .insert(studioMediaAssets)
    .values({
      actorId: 42,
      kind: "video",
      mimeType: "video/mp4",
      filename: "clip.mp4",
      localPath: source,
      byteSize: 1,
      sha256: `video-service-boundary-${fixtureSequence++}`,
      source: "test_upload",
      createdAt: now,
    })
    .returning({ id: studioMediaAssets.id })
    .get();
  if (!asset) throw new Error("video fixture asset was not created");
  const draftId = createVideoDraft(backendDb, 42, { studioMediaAssetId: asset.id }, 24);
  replaceVideoTargets(backendDb, draftId, targets as ("youtube_shorts" | "instagram_reels")[]);
  const config = loadConfig({
    ADMIN_IDS: "42",
    INSTAGRAM_ACCESS_TOKEN: "instagram-token",
    INSTAGRAM_USER_ID: "instagram-user",
    STUDIO_MEDIA_DIR: directory,
    VIDEO_MEDIA_DIR: directory,
  });
  config.studio.modules.video_posting = true;
  config.studio.modules.instagram = true;
  return { config, directory, draftId };
}

async function withFixture<T>(fn: (backendDb: UnsafeBackendDb, fixture: VideoFixture) => Promise<T> | T, targets?: string[]): Promise<T> {
  return withDb(async (backendDb) => {
    const current = fixture(backendDb, targets);
    try {
      return await fn(backendDb, current);
    } finally {
      rmSync(current.directory, { recursive: true, force: true });
    }
  });
}

describe("video Studio service boundary", () => {
  it("validates, schedules through the shared PublicationSchedule shape, and arms grouped reminders", async () => {
    await withFixture(async (backendDb, current) => {
      const service = videoService(backendDb, current.config);
      expect(service.list(42)).toHaveLength(1);
      expect(service.metadataEditableTargets(42, current.draftId)).toEqual(["instagram_reels"]);
      expect(await service.validate(42, current.draftId)).toEqual([]);
      expect((await service.technicalCheck(42, current.draftId)).videoCodec).toBe("h264");

      const publishAt = new Date(Date.now() + 90 * 60_000);
      const technical = await service.schedule(42, current.draftId, {
        values: { instagram_reels: publishAt, ignored_target: publishAt },
      });

      expect(technical.seconds).toBeGreaterThan(0);
      expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, current.draftId)).get()).toMatchObject({
        target: "instagram_reels",
        status: "scheduled",
        scheduledAt: publishAt.toISOString(),
        metadataJson: { videoDurationMs: technical.seconds * 1_000 },
      });
      expect(backendDb.db.select().from(videoJobs).where(eq(videoJobs.videoDraftId, current.draftId)).all()).toHaveLength(2);
      expect(backendDb.db.select().from(studioNotificationJobs).all()).toMatchObject([
        {
          ref: `publication:video:${current.draftId}`,
          status: "queued",
          payloadJson: { targets: ["instagram_reels"] },
        },
      ]);
    });
  });

  it("publishes through the same scheduling path and rejects an owned draft with no targets", async () => {
    await withFixture(async (backendDb, current) => {
      const service = videoService(backendDb, current.config);
      await service.publish(42, current.draftId);
      expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, current.draftId)).get()).toMatchObject({
        status: "scheduled",
      });
      expect(backendDb.db.select().from(studioNotificationJobs).all()).toHaveLength(1);

      const empty = fixture(backendDb, ["instagram_reels"]);
      try {
        backendDb.db.delete(videoTargets).where(eq(videoTargets.videoDraftId, empty.draftId)).run();
        await expect(videoService(backendDb, current.config).publish(42, empty.draftId)).rejects.toThrow("err.video-choose-platforms");
      } finally {
        rmSync(empty.directory, { recursive: true, force: true });
      }
    });
  });

  it("exposes status, history, metadata commands, retry, manual scheduling, and target toggles", async () => {
    await withFixture(async (backendDb, current) => {
      const service = videoService(backendDb, current.config);
      expect(service.status(42, current.draftId).jobs).toEqual([]);
      expect(service.history(42, current.draftId)).toEqual([]);
      service.updateMetadata(42, current.draftId, "instagram_reels", { caption: "caption" });
      service.editMetadataField(42, current.draftId, "instagram_caption", "new caption");
      service.completeWizardTarget(42, current.draftId, "instagram_reels", { instagram_caption: "wizard caption" }, ["instagram_reels"]);
      service.rename(42, current.draftId, "Renamed video");
      expect(service.get(42, current.draftId).draft.label).toBe("Renamed video");
      expect(service.manualSchedule(42, current.draftId, "23:15")).toBeInstanceOf(Date);

      const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, current.draftId)).get();
      if (!target) throw new Error("video target missing");
      backendDb.db.update(videoTargets).set({ status: "failed" }).where(eq(videoTargets.id, target.id)).run();
      expect(service.retryTarget(42, current.draftId, "instagram_reels")).toEqual({ requeued: 1, alreadyQueued: 0 });

      const toggle = fixture(backendDb, ["youtube_shorts"]);
      try {
        const toggleService = videoService(backendDb, current.config);
        toggleService.toggleTarget(42, toggle.draftId, "instagram_reels");
        expect(toggleService.metadataEditableTargets(42, toggle.draftId)).toEqual(["youtube_shorts", "instagram_reels"]);
        toggleService.toggleTarget(42, toggle.draftId, "instagram_reels");
        expect(toggleService.metadataEditableTargets(42, toggle.draftId)).toEqual(["youtube_shorts"]);
      } finally {
        rmSync(toggle.directory, { recursive: true, force: true });
      }
    });
  });
});
