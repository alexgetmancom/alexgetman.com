import { eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { analyticsSync, creatorProfileSnapshots, creatorProfiles, socialComments } from "../../db/schema.js";

const DAILY_SYNC_MS = 24 * 60 * 60_000;

export function canSync(backendDb: BackendDb, source: string, intervalSeconds = DAILY_SYNC_MS / 1000): boolean {
  const row = backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, source)).get();
  return !row || Date.now() - new Date(row.lastSyncedAt).getTime() >= intervalSeconds * 1000;
}

export function markSynced(backendDb: BackendDb, source: string, error: string | null = null): void {
  const lastSyncedAt = new Date().toISOString();
  backendDb.db
    .insert(analyticsSync)
    .values({ source, lastSyncedAt, lastSuccessAt: error ? null : lastSyncedAt, lastError: error })
    .onConflictDoUpdate({
      target: analyticsSync.source,
      set: { lastSyncedAt, ...(error ? { lastError: error } : { lastSuccessAt: lastSyncedAt, lastError: null }) },
    })
    .run();
}

function upsertProfile(backendDb: BackendDb, platform: string, data: Record<string, unknown>): void {
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

/** Saves the current profile projection and a single UTC-day observation. */
export function recordProfileSnapshot(
  backendDb: BackendDb,
  input: { platform: string; account: string; metrics: Record<string, unknown>; source: string; sampledAt?: Date },
): void {
  const sampledAt = input.sampledAt ?? new Date();
  const timestamp = sampledAt.toISOString();
  backendDb.db
    .insert(creatorProfileSnapshots)
    .values({
      platform: input.platform,
      account: input.account,
      sampledOn: timestamp.slice(0, 10),
      metricsJson: input.metrics,
      source: input.source,
      sampledAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [creatorProfileSnapshots.platform, creatorProfileSnapshots.account, creatorProfileSnapshots.sampledOn],
      set: { metricsJson: input.metrics, source: input.source, sampledAt: timestamp },
    })
    .run();
  upsertProfile(backendDb, input.platform, input.metrics);
}

export function upsertVideoSnapshot(
  backendDb: BackendDb,
  videoTargetId: number,
  platform: string,
  checkpointIndex: number,
  metrics: Record<string, unknown>,
): void {
  const sampledAt = new Date().toISOString();
  backendDb.sqlite
    .prepare(
      "INSERT INTO video_metric_snapshots (video_target_id, platform, metrics_json, checkpoint_index, sampled_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(video_target_id, checkpoint_index) WHERE checkpoint_index IS NOT NULL DO UPDATE SET platform=excluded.platform, metrics_json=excluded.metrics_json, sampled_at=excluded.sampled_at",
    )
    .run(videoTargetId, platform, JSON.stringify(metrics), checkpointIndex, sampledAt);
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
