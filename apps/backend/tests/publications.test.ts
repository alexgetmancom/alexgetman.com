import { afterEach, describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { studioMediaAssets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { postService } from "../src/studio/services/posts.js";
import { publicationPipelineService } from "../src/studio/services/publication-pipeline.js";
import { videoService } from "../src/studio/services/videos.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: UnsafeBackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

function videoAssetId(db: UnsafeBackendDb): number {
  const now = new Date().toISOString();
  const [row] = db.db
    .insert(studioMediaAssets)
    .values({
      actorId: 42,
      kind: "video",
      mimeType: "video/mp4",
      filename: "clip.mp4",
      localPath: "/tmp/clip.mp4",
      byteSize: 1,
      sha256: "clip",
      source: "test_upload",
      createdAt: now,
    })
    .returning({ id: studioMediaAssets.id })
    .all();
  if (!row) throw new Error("asset insert failed");
  return row.id;
}

describe("Studio publication pipeline", () => {
  it("dispatches create to the right pipeline and tags the handle by kind", () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({ ADMIN_IDS: "42" });
    const pipeline = publicationPipelineService(postService(backendDb, config), videoService(backendDb, config));

    const post = pipeline.create(42, { kind: "post", message: { text: "Hello", textEn: "Hello", entities: [], media: [] } });
    expect(post).toEqual({ kind: "post", id: 1 });
    expect(pipeline.capabilities("post")).toEqual({ hasMetadataWizard: false, hasStoryCards: true, scheduleAxis: "locale" });

    const asset = videoAssetId(backendDb);
    const video = pipeline.create(42, { kind: "video", studioMediaAssetId: asset });
    expect(video).toEqual({ kind: "video", id: 1 });
    expect(pipeline.capabilities("video")).toEqual({ hasMetadataWizard: true, hasStoryCards: false, scheduleAxis: "target" });
    expect(typeof pipeline.slotTime(post, "08:30").toISOString()).toBe("string");
    expect(typeof pipeline.slotTime(video, "08:30").toISOString()).toBe("string");
  });
});
