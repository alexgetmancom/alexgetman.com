import { eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { alertDedup, analyticsSync, creatorProfileSnapshots, creatorProfiles, postEvents, socialComments } from "../../db/schema.js";

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

const FOLLOWER_MILESTONES = [100, 250, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000];

function followerCount(data: Record<string, unknown> | undefined): number {
  return metricNumber(data?.subscriberCount ?? data?.followersCount);
}

function recordMilestone(backendDb: BackendDb, scope: string, threshold: number, message: string, target: string): void {
  const key = `analytics:milestone:${scope}:${threshold}`;
  if (backendDb.db.select().from(alertDedup).where(eq(alertDedup.alertKey, key)).get()) return;
  const now = new Date().toISOString();
  backendDb.db.insert(alertDedup).values({ alertKey: key, lastSentAt: now, suppressedCount: 0 }).run();
  backendDb.db
    .insert(postEvents)
    .values({ eventType: "analytics.milestone.reached", severity: "info", target, message, createdAt: now })
    .run();
}

function recordFollowerMilestones(
  backendDb: BackendDb,
  platform: string,
  next: Record<string, unknown>,
  audiencePlatforms: readonly string[] | undefined,
): void {
  const previous = backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, platform)).get();
  const before = followerCount(previous?.dataJson);
  const after = followerCount(next);
  if (after <= before) return;
  const platformLabel = platform === "youtube" ? "YouTube" : platform === "instagram" ? "Instagram" : platform;
  for (const threshold of FOLLOWER_MILESTONES)
    if (before < threshold && after >= threshold)
      recordMilestone(backendDb, platform, threshold, `🎉 ${platformLabel}: ${threshold} подписчиков!`, platform);
  const platforms = new Set(audiencePlatforms ?? []);
  if (!platforms.has(platform)) return;
  const totalBefore = backendDb.db
    .select()
    .from(creatorProfiles)
    .all()
    .filter((row) => platforms.has(row.platform))
    .reduce((sum, row) => sum + followerCount(row.dataJson), 0);
  const totalAfter = totalBefore - before + after;
  for (const threshold of FOLLOWER_MILESTONES)
    if (totalBefore < threshold && totalAfter >= threshold)
      recordMilestone(backendDb, "total", threshold, `🏆 Всего: ${threshold} подписчиков на площадках!`, "audience");
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
    /** Exact Studio-owned platforms that count toward the combined milestone. */
    audiencePlatforms?: readonly string[];
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
  recordFollowerMilestones(backendDb, input.platform, input.metrics, input.audiencePlatforms);
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
