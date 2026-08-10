import crypto from "node:crypto";
import path from "node:path";
import { type BackendDb, unsafeDb } from "../../src/db/client.js";
import { studioMediaAssets } from "../../src/db/schema.js";
import { createVideoDraft } from "../../src/publishing/video-service.js";
import type { VideoLocale } from "../../src/publishing/video-types.js";

export function createTestVideoDraft(
  backendDb: BackendDb,
  actorId: number,
  source: string | number,
  retentionHours: number,
  locale: VideoLocale = "ru",
): number {
  if (typeof source === "number") return createVideoDraft(backendDb, actorId, source, retentionHours, locale);
  return createVideoDraft(backendDb, actorId, createTestVideoAsset(backendDb, actorId, source), retentionHours, locale);
}

export function createTestVideoAsset(backendDb: BackendDb, actorId = 1, source = "/tmp/test-video.mp4"): number {
  const asset = unsafeDb(backendDb)
    .db.insert(studioMediaAssets)
    .values({
      actorId,
      kind: "video",
      mimeType: "video/mp4",
      filename: path.basename(source),
      localPath: source,
      byteSize: 1,
      sha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      source: "test",
      createdAt: new Date().toISOString(),
    })
    .returning({ id: studioMediaAssets.id })
    .get();
  if (!asset) throw new Error("Test video asset was not created");
  return asset.id;
}
