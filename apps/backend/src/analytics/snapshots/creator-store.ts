import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { analyticsSync, creatorProfileSnapshots, creatorProfiles, socialComments } from "../../db/schema.js";

/** Atomically reserves a due profile sync for one worker instance. */
export function claimSync(backendDb: BackendDb, source: string, intervalSeconds: number, owner: string): boolean {
  const now = new Date().toISOString();
  const dueBefore = new Date(Date.now() - intervalSeconds * 1000).toISOString();
  const staleBefore = new Date(Date.now() - intervalSeconds * 2 * 1000).toISOString();
  backendDb.db
    .insert(analyticsSync)
    .values({ source, lastSyncedAt: new Date(0).toISOString(), lastSuccessAt: null, lastError: null, lockedBy: null, lockedAt: null })
    .onConflictDoNothing()
    .run();
  return Boolean(
    backendDb.db
      .update(analyticsSync)
      .set({ lockedBy: owner, lockedAt: now })
      .where(
        and(
          eq(analyticsSync.source, source),
          lte(analyticsSync.lastSyncedAt, dueBefore),
          or(isNull(analyticsSync.lockedBy), isNull(analyticsSync.lockedAt), lt(analyticsSync.lockedAt, staleBefore)),
        ),
      )
      .returning({ source: analyticsSync.source })
      .get(),
  );
}

export function markSynced(backendDb: BackendDb, source: string, error: string | null = null, owner?: string): void {
  const lastSyncedAt = new Date().toISOString();
  if (!owner) {
    backendDb.db
      .insert(analyticsSync)
      .values({ source, lastSyncedAt, lastSuccessAt: error ? null : lastSyncedAt, lastError: error, lockedBy: null, lockedAt: null })
      .onConflictDoUpdate({
        target: analyticsSync.source,
        set: {
          lastSyncedAt,
          ...(error ? { lastError: error } : { lastSuccessAt: lastSyncedAt, lastError: null }),
          lockedBy: null,
          lockedAt: null,
        },
      })
      .run();
    return;
  }
  backendDb.db
    .update(analyticsSync)
    .set({
      lastSyncedAt,
      ...(error ? { lastError: error } : { lastSuccessAt: lastSyncedAt, lastError: null }),
      lockedBy: null,
      lockedAt: null,
    })
    .where(owner ? and(eq(analyticsSync.source, source), eq(analyticsSync.lockedBy, owner)) : eq(analyticsSync.source, source))
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

/** Saves the current profile projection and an observation bucket. Most
 * platforms retain one durable daily sample; YouTube additionally retains an
 * hourly bucket so its live channel-view delta can cover the last 24 hours. */
export function recordProfileSnapshot(
  backendDb: BackendDb,
  input: {
    platform: string;
    account: string;
    metrics: Record<string, unknown>;
    source: string;
    /** Retained in the collector contract for compatibility. Milestone grouping
     * now comes from the durable channel registry after the complete cycle. */
    audiencePlatforms: readonly string[];
    sampledAt?: Date;
    /** "hour" is intentionally used only for the video analytics feed. */
    resolution?: "day" | "hour";
  },
): void {
  const sampledAt = input.sampledAt ?? new Date();
  const timestamp = sampledAt.toISOString();
  const sampledOn = input.resolution === "hour" ? timestamp.slice(0, 13) : timestamp.slice(0, 10);
  backendDb.db
    .insert(creatorProfileSnapshots)
    .values({
      platform: input.platform,
      account: input.account,
      sampledOn,
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

/** Adds provider-specific enrichment to the snapshot written by the base collector. */
export function mergeVideoSnapshot(
  backendDb: BackendDb,
  videoTargetId: number,
  platform: string,
  checkpointIndex: number,
  metrics: Record<string, unknown>,
): void {
  const existing = backendDb.sqlite
    .prepare("SELECT metrics_json AS metricsJson FROM video_metric_snapshots WHERE video_target_id=? AND checkpoint_index=?")
    .get(videoTargetId, checkpointIndex) as { metricsJson?: string } | null;
  let current: Record<string, unknown> = {};
  if (existing?.metricsJson) {
    try {
      current = JSON.parse(existing.metricsJson) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  upsertVideoSnapshot(backendDb, videoTargetId, platform, checkpointIndex, { ...current, ...metrics });
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
