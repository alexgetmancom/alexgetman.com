import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { studioMediaAssets } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";

/** Content-owned persistence for raw video assets, independent of ingress UI. */
export function videoPath(config: BackendConfig, assetKey: string): string | null {
  if (!existsSync(config.VIDEO_MEDIA_DIR)) return null;
  const match = readdirSync(config.VIDEO_MEDIA_DIR).find((entry) => entry.startsWith(`${assetKey}.`));
  return match ? path.join(config.VIDEO_MEDIA_DIR, match) : null;
}

export function deleteVideo(config: BackendConfig, assetKey: string): void {
  const file = videoPath(config, assetKey);
  if (file) rmSync(file, { force: true });
}

/** Resolves a neutral Studio asset first; legacy asset keys remain readable during migration. */
export function videoSourcePath(
  backendDb: BackendDb,
  config: BackendConfig,
  source: { assetKey: string; studioMediaAssetId: number | null },
): string | null {
  if (source.studioMediaAssetId != null) {
    const asset = backendDb.db.select().from(studioMediaAssets).where(eq(studioMediaAssets.id, source.studioMediaAssetId)).get();
    return asset?.kind === "video" && existsSync(asset.localPath) ? asset.localPath : null;
  }
  return videoPath(config, source.assetKey);
}

export function videoPublicUrl(
  backendDb: BackendDb,
  config: BackendConfig,
  source: { assetKey: string; studioMediaAssetId: number | null },
): string {
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (source.studioMediaAssetId == null) return `${base}/media/video/${source.assetKey}`;
  // The public media route is content-addressed by sha256 so the unguessable
  // digest, not the enumerable asset id, is what grants read access.
  const asset = backendDb.db
    .select({ sha256: studioMediaAssets.sha256 })
    .from(studioMediaAssets)
    .where(eq(studioMediaAssets.id, source.studioMediaAssetId))
    .get();
  if (!asset) throw new Error(`Studio media asset ${source.studioMediaAssetId} has no public URL`);
  return `${base}/media/video/asset/${asset.sha256}`;
}
