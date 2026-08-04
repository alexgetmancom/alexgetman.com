import { afterEach, describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { studioMediaAssets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { postService } from "../src/studio/services/posts.js";
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

describe("Studio publication services", () => {
  it("creates posts and videos through their direct service boundaries", () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({ ADMIN_IDS: "42" });
    const posts = postService(backendDb, config);
    const videos = videoService(backendDb, config);

    const postId = posts.create(42, { text: "Hello", textEn: "Hello", entities: [], media: [] });
    expect(postId).toBe(1);

    const asset = videoAssetId(backendDb);
    const videoId = videos.create(42, asset);
    expect(videoId).toBe(1);
    expect(typeof posts.slotTime("08:30").toISOString()).toBe("string");
    expect(typeof videos.slotTime("08:30").toISOString()).toBe("string");
  });
});
