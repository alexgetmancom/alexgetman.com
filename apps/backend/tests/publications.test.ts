import { afterEach, describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { studioMediaAssets } from "../src/db/schema.js";
import { postService } from "../src/studio/services/posts.js";
import { videoService } from "../src/studio/services/videos.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

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

describe("Studio publication services", () => {
  it("creates posts and videos through their direct service boundaries", () => {
    backendDb = openBackendDb(":memory:");
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
    const posts = postService(backendDb, config);
    const videos = videoService(backendDb, config);

    const postId = posts.create(42, { text: "Hello", textEn: "Hello", entities: [], media: [] });
    expect(postId).toBe(1);
    expect(posts.get(42, postId).id).toBe(postId);
    expect(posts.preview(42, postId).id).toBe(postId);

    const asset = videoAssetId(backendDb);
    const videoId = videos.create(42, asset);
    expect(videoId).toBe(1);
    expect(videos.get(42, videoId).draft.id).toBe(videoId);
    expect(videos.preview(42, videoId).draft.id).toBe(videoId);
  });
});
