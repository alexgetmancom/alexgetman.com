import { eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { analyticsSync, creatorProfiles, socialComments, videoMetricSnapshots } from "../db/schema.js";

const DAILY_SYNC_MS = 24 * 60 * 60_000;

export function canSync(backendDb: BackendDb, source: string): boolean {
  const row = backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, source)).get();
  return !row || Date.now() - new Date(row.lastSyncedAt).getTime() >= DAILY_SYNC_MS;
}

export function markSynced(backendDb: BackendDb, source: string, error: string | null = null): void {
  const lastSyncedAt = new Date().toISOString();
  backendDb.db
    .insert(analyticsSync)
    .values({ source, lastSyncedAt, lastError: error })
    .onConflictDoUpdate({
      target: analyticsSync.source,
      set: { lastSyncedAt, lastError: error },
    })
    .run();
}

export function upsertProfile(backendDb: BackendDb, platform: string, data: Record<string, unknown>): void {
  const updatedAt = new Date().toISOString();
  backendDb.db
    .insert(creatorProfiles)
    .values({ platform, dataJson: data, updatedAt })
    .onConflictDoUpdate({
      target: creatorProfiles.platform,
      set: { dataJson: data, updatedAt },
    })
    .run();
}

export function upsertVideoSnapshot(backendDb: BackendDb, videoTargetId: number, platform: string, metrics: Record<string, unknown>): void {
  backendDb.db
    .insert(videoMetricSnapshots)
    .values({
      videoTargetId,
      platform,
      metricsJson: metrics,
      sampledAt: new Date().toISOString(),
    })
    .run();
}

export function upsertComment(
  backendDb: BackendDb,
  platform: "youtube" | "instagram",
  commentId: string,
  videoTargetId: number,
  text: string,
  author: string | undefined,
  likeCount: number,
  publishedAt: string | undefined,
): void {
  backendDb.db
    .insert(socialComments)
    .values({
      platform,
      commentId,
      videoTargetId,
      author: author ?? null,
      text,
      likeCount,
      publishedAt: publishedAt ?? null,
      fetchedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [socialComments.platform, socialComments.commentId],
      set: { text, likeCount, fetchedAt: new Date().toISOString() },
    })
    .run();
}

export function metricNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}
