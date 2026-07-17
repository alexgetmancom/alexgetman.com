import { afterEach, describe, expect, it } from "bun:test";
import type { BackendDb } from "../src/db/client.js";
import { openBackendDb } from "../src/db/client.js";
import { studioMediaAssets } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { publicationService } from "../src/studio/services/publications.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

function videoAssetId(db: BackendDb): number {
  const now = new Date().toISOString();
  const [row] = db.db
    .insert(studioMediaAssets)
    .values({
      adminId: 42,
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

describe("Studio publication facade", () => {
  it("dispatches create to the right pipeline and tags the handle by kind", () => {
    backendDb = openBackendDb(":memory:");
    const publications = publicationService(backendDb, loadConfig({ ADMIN_IDS: "42" }));

    const post = publications.create(42, { kind: "post", message: { text: "Hello", textEn: "Hello", entities: [], media: [] } });
    expect(post).toEqual({ kind: "post", id: 1 });

    const asset = videoAssetId(backendDb);
    const video = publications.create(42, { kind: "video", studioMediaAssetId: asset });
    expect(video).toEqual({ kind: "video", id: 1 });
  });

  it("routes read and cancel verbs through the same owner check as the underlying service", () => {
    backendDb = openBackendDb(":memory:");
    const publications = publicationService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const post = publications.create(42, { kind: "post", message: { text: "Owned", textEn: "Owned", entities: [], media: [] } });

    const draft = publications.get(42, post) as { id: number; status: string };
    expect(draft.id).toBe(post.id);
    expect(() => publications.get(7, post)).toThrow("err.post-not-yours");
    expect(() => publications.cancel(7, post)).toThrow("err.post-not-yours");

    publications.cancel(42, post);
    expect((publications.get(42, post) as { status: string }).status).toBe("cancelled");
  });
});
