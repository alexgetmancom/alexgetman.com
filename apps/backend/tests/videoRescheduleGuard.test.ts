import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { videoJobs, videoTargets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { createVideoDraft, replaceVideoTargets, scheduleVideo } from "../src/publishing/video-service.js";
import { useBackendDb } from "./helpers/db.js";

const testDb = useBackendDb();

function videoConfig() {
  const config = loadConfig({});
  config.studio.modules.video_posting = true;
  config.studio.modules.youtube = true;
  return config;
}

const timing = { prepareLeadMinutes: 10, reminderMinutes: 15 };

describe("video reschedule guard", () => {
  it("refuses to reschedule a platform that already published", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);
    const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
    if (!target) throw new Error("target was not created");
    backendDb.db.update(videoTargets).set({ status: "published" }).where(eq(videoTargets.id, target.id)).run();

    expect(() =>
      scheduleVideo(backendDb, draftId, { youtube_shorts: new Date(Date.now() + 3_600_000) }, timing, videoConfig(), 24),
    ).toThrow("err.video-target-not-schedulable");

    // The published target keeps its state and gains no second delivery pair.
    const after = backendDb.db.select().from(videoTargets).where(eq(videoTargets.id, target.id)).get();
    expect(after?.status).toBe("published");
    expect(backendDb.db.select().from(videoJobs).where(eq(videoJobs.videoDraftId, draftId)).all()).toEqual([]);
  });

  it("still schedules a platform that has not been delivered", () => {
    const backendDb = testDb.open();
    const draftId = createVideoDraft(backendDb, 42, "video-source", 24);
    replaceVideoTargets(backendDb, draftId, ["youtube_shorts"]);

    scheduleVideo(backendDb, draftId, { youtube_shorts: new Date(Date.now() + 3_600_000) }, timing, videoConfig(), 24);

    const target = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
    expect(target?.status).toBe("scheduled");
    expect(
      backendDb.db
        .select()
        .from(videoJobs)
        .where(eq(videoJobs.videoDraftId, draftId))
        .all()
        .map((job) => job.kind)
        .sort(),
    ).toEqual(["prepare", "publish"]);
  });
});
