import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { parseArrayValue } from "../content/message.js";
import { deleteVideo } from "../content/video-assets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, studioMediaAssets, videoDrafts } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";

/** Reclaims video source files whose drafts are final and past their
 * retention window. Runs at the tail of every video cycle; deliberately
 * separate from job execution — it touches no jobs, locks or targets. */
export function pruneExpiredVideos(config: BackendConfig, backendDb: BackendDb): void {
  const now = new Date().toISOString();
  const legacyDraftExpiresAt = new Date(Date.now() - config.VIDEO_MEDIA_RETENTION_HOURS * 60 * 60_000).toISOString();
  const rows = unsafeDb(backendDb)
    .db.select()
    .from(videoDrafts)
    .where(
      and(
        // The source is reclaimed exactly once. retentionUntil cannot record
        // that: it is recomputed from scratch on every target change, and the
        // sweep itself used to clear it — so a long-finished draft matched the
        // legacy branch again one retention window later, and every window
        // after that, re-touching updatedAt (which orders the Studio video
        // list) on a draft nobody had opened in months.
        isNull(videoDrafts.sourcePrunedAt),
        or(
          and(
            lte(videoDrafts.retentionUntil, now),
            or(
              eq(videoDrafts.status, "published"),
              eq(videoDrafts.status, "partial"),
              eq(videoDrafts.status, "cancelled"),
              eq(videoDrafts.status, "editing"),
            ),
          ),
          // Before Studio assets gained the same retention policy, final drafts
          // had their deadline cleared while their source file lived forever.
          // Pick those up once they have been final for a full retention window.
          and(
            isNotNull(videoDrafts.studioMediaAssetId),
            isNull(videoDrafts.retentionUntil),
            inArray(videoDrafts.status, ["published", "partial", "cancelled"]),
            lte(videoDrafts.updatedAt, legacyDraftExpiresAt),
          ),
          and(eq(videoDrafts.status, "editing"), isNull(videoDrafts.retentionUntil), lte(videoDrafts.createdAt, legacyDraftExpiresAt)),
        ),
      ),
    )
    .all();
  for (const row of rows) {
    if (row.studioMediaAssetId == null) deleteVideo(config, row.assetKey);
    else pruneStudioAssetSource(config, backendDb, row.studioMediaAssetId, now);
    unsafeDb(backendDb)
      .db.update(videoDrafts)
      .set({
        status: row.status === "editing" ? "cancelled" : row.status,
        retentionUntil: null,
        sourcePrunedAt: now,
        updatedAt: now,
      })
      .where(eq(videoDrafts.id, row.id))
      .run();
  }
}

/** Studio metadata remains available for published-history and analytics, but
 * the original upload is disposable after every draft using it is final. */
function pruneStudioAssetSource(config: BackendConfig, backendDb: BackendDb, assetId: number, now: string): void {
  const drafts = unsafeDb(backendDb)
    .db.select({ status: videoDrafts.status, retentionUntil: videoDrafts.retentionUntil })
    .from(videoDrafts)
    .where(eq(videoDrafts.studioMediaAssetId, assetId))
    .all();
  if (
    !drafts.length ||
    !drafts.every(
      (draft) =>
        ["published", "partial", "cancelled"].includes(draft.status) && (draft.retentionUntil == null || draft.retentionUntil <= now),
    )
  )
    return;
  // Post attachments still use durable JSON for compatibility with old drafts.
  // Never remove a shared source merely because the video side became final.
  if (postDraftReferencesAsset(backendDb, assetId)) return;
  const asset = unsafeDb(backendDb)
    .db.select({ localPath: studioMediaAssets.localPath })
    .from(studioMediaAssets)
    .where(eq(studioMediaAssets.id, assetId))
    .get();
  if (!asset || !isManagedVideoSource(config, asset.localPath)) return;
  fs.rmSync(asset.localPath, { force: true });
}

function postDraftReferencesAsset(backendDb: BackendDb, assetId: number): boolean {
  return unsafeDb(backendDb)
    .db.select({ mediaRuJson: drafts.mediaRuJson, mediaEnJson: drafts.mediaEnJson })
    .from(drafts)
    .all()
    .some((draft) =>
      [draft.mediaRuJson, draft.mediaEnJson].some((value) => parseArrayValue(value).some((item) => Number(item.asset_id) === assetId)),
    );
}

function isManagedVideoSource(config: BackendConfig, source: string): boolean {
  const resolved = path.resolve(source);
  return [config.STUDIO_MEDIA_DIR, config.VIDEO_MEDIA_DIR].some((root) => {
    const directory = path.resolve(root);
    return resolved.startsWith(`${directory}${path.sep}`);
  });
}
