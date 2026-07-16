import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { videoDrafts, videoMetricSchedule, videoTargets } from "../../db/schema.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { youtubeAccessToken } from "../../foundation/external/youtube.js";
import { requestJson } from "../../foundation/http.js";
import { metricNumber, upsertComment, upsertVideoSnapshot } from "../snapshots/creator-store.js";
import { isTerminalMetricError, terminalIfMissingRemoteObject } from "./collectors/errors.js";
import { videoMetricCheckpointAt } from "./metric-checkpoints.js";

type VideoMetricTask = {
  id: number;
  videoDraftId: number;
  target: "youtube_shorts" | "instagram_reels";
  externalId: string;
  externalUrl: string | null;
  publishedAt: string;
  label: string | null;
  checkpointIndex: number;
};
type YouTubeVideo = {
  items?: Array<{
    snippet?: { title?: string; publishedAt?: string };
    statistics?: Record<string, string>;
  }>;
};
type YouTubeComments = {
  items?: Array<{
    id?: string;
    snippet?: {
      topLevelComment?: {
        snippet?: {
          textDisplay?: string;
          authorDisplayName?: string;
          publishedAt?: string;
          likeCount?: number;
        };
      };
    };
  }>;
};
type InstagramMedia = {
  like_count?: number;
  comments_count?: number;
  permalink?: string;
  timestamp?: string;
};
type InstagramInsights = { data?: Array<{ values?: Array<{ value?: number }> }> };
type InstagramComments = {
  data?: Array<{
    id?: string;
    text?: string;
    username?: string;
    timestamp?: string;
    like_count?: number;
  }>;
};

/** Uses the same fixed-from-publication checkpoints as text-post metrics. */
export async function runVideoMetricSchedule(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<number> {
  ensureVideoMetricSchedule(backendDb);
  const tasks = dueVideoMetricTasks(backendDb, config.MAX_METRIC_TASKS_PER_CYCLE);
  for (const task of tasks) {
    try {
      if (task.target === "youtube_shorts") await collectYouTubeVideoMetrics(config, backendDb, task, fetchImpl);
      else await collectInstagramVideoMetrics(config, backendDb, task, fetchImpl);
      finishVideoMetricTask(backendDb, task, null);
    } catch (error) {
      const normalized = terminalIfMissingRemoteObject(error);
      finishVideoMetricTask(
        backendDb,
        task,
        normalized instanceof Error ? normalized.message : String(normalized),
        isTerminalMetricError(normalized),
      );
      if (isTerminalMetricError(normalized))
        recordDomainEvent(backendDb, {
          ref: `video:${task.videoDraftId}`,
          target: task.target,
          type: "analytics.video_metrics.frozen",
          severity: "warn",
          message: normalized.message,
          details: { video_target_id: task.id, reason: normalized.message },
          cooldownSeconds: 60 * 60,
        });
    }
  }
  return tasks.length;
}

function ensureVideoMetricSchedule(backendDb: BackendDb): void {
  const now = new Date().toISOString();
  const targets = backendDb.db
    .select({ id: videoTargets.id, publishedAt: videoTargets.publishedAt })
    .from(videoTargets)
    .where(
      and(eq(videoTargets.status, "published"), or(eq(videoTargets.target, "youtube_shorts"), eq(videoTargets.target, "instagram_reels"))),
    )
    .all();
  for (const target of targets) {
    const publishedAt = new Date(target.publishedAt ?? now);
    backendDb.db
      .insert(videoMetricSchedule)
      .values({
        videoTargetId: target.id,
        checkpointIndex: 0,
        nextCheckAt: videoMetricCheckpointAt(publishedAt.toISOString(), 0, publishedAt).toISOString(),
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
}

function dueVideoMetricTasks(backendDb: BackendDb, limit: number): VideoMetricTask[] {
  const now = new Date().toISOString();
  return backendDb.db
    .select({
      id: videoTargets.id,
      videoDraftId: videoTargets.videoDraftId,
      target: videoTargets.target,
      externalId: videoTargets.externalId,
      externalUrl: videoTargets.externalUrl,
      publishedAt: videoTargets.publishedAt,
      label: videoDrafts.label,
      checkpointIndex: videoMetricSchedule.checkpointIndex,
    })
    .from(videoMetricSchedule)
    .innerJoin(videoTargets, eq(videoTargets.id, videoMetricSchedule.videoTargetId))
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .where(
      and(
        eq(videoTargets.status, "published"),
        isNull(videoMetricSchedule.frozenAt),
        lte(videoMetricSchedule.nextCheckAt, now),
        or(eq(videoTargets.target, "youtube_shorts"), eq(videoTargets.target, "instagram_reels")),
      ),
    )
    .orderBy(asc(videoMetricSchedule.nextCheckAt))
    .limit(limit)
    .all()
    .filter((task) => Boolean(task.externalId && task.publishedAt)) as VideoMetricTask[];
}

function finishVideoMetricTask(backendDb: BackendDb, task: VideoMetricTask, error: string | null, terminal = false): void {
  const now = new Date();
  const nextIndex = error ? task.checkpointIndex : task.checkpointIndex + 1;
  const nextCheckAt = terminal
    ? null
    : error
      ? new Date(now.getTime() + 15 * 60_000)
      : videoMetricCheckpointAt(task.publishedAt, nextIndex, now);
  backendDb.db
    .update(videoMetricSchedule)
    .set({
      checkpointIndex: nextIndex,
      // The schedule row keeps a non-null timestamp for legacy SQLite schema;
      // frozenAt is the authoritative terminal-state flag.
      nextCheckAt: (nextCheckAt ?? now).toISOString(),
      lastCheckedAt: now.toISOString(),
      lastError: error,
      frozenAt: nextCheckAt == null ? now.toISOString() : null,
      updatedAt: now.toISOString(),
    })
    .where(eq(videoMetricSchedule.videoTargetId, task.id))
    .run();
}

async function collectYouTubeVideoMetrics(
  config: BackendConfig,
  backendDb: BackendDb,
  target: VideoMetricTask,
  fetchImpl: typeof fetch,
): Promise<void> {
  const token = await youtubeAccessToken(config);
  const auth = { Authorization: `Bearer ${token}` };
  const video = await requestJson<YouTubeVideo>(
    fetchImpl,
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(target.externalId)}`,
    { headers: auth },
  );
  const item = video.items?.[0];
  upsertVideoSnapshot(backendDb, target.id, "youtube_shorts", target.checkpointIndex, {
    title: item?.snippet?.title ?? target.label ?? "Без названия",
    url: target.externalUrl,
    publishedAt: item?.snippet?.publishedAt ?? target.publishedAt,
    views: metricNumber(item?.statistics?.viewCount),
    likes: metricNumber(item?.statistics?.likeCount),
    comments: metricNumber(item?.statistics?.commentCount),
  });
  // The basic video read works with the publishing token. Comment threads
  // additionally require youtube.force-ssl; comments are enrichment and must
  // never make the entire video metrics checkpoint fail or retry noisily.
  let comments: YouTubeComments | null = null;
  try {
    comments = await requestJson<YouTubeComments>(
      fetchImpl,
      `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(target.externalId)}&maxResults=50&order=time`,
      { headers: auth },
    );
  } catch (error) {
    if (!isInsufficientYouTubeCommentScope(error)) throw error;
  }
  for (const comment of comments?.items ?? []) {
    const details = comment.snippet?.topLevelComment?.snippet;
    if (comment.id && details?.textDisplay)
      upsertComment(
        backendDb,
        "youtube",
        comment.id,
        target.id,
        details.textDisplay,
        details.authorDisplayName,
        metricNumber(details.likeCount),
        details.publishedAt,
      );
  }
}

async function collectInstagramVideoMetrics(
  config: BackendConfig,
  backendDb: BackendDb,
  target: VideoMetricTask,
  fetchImpl: typeof fetch,
): Promise<void> {
  const token = config.INSTAGRAM_ACCESS_TOKEN;
  if (!token) throw new Error("Instagram credentials are missing");
  const base = `https://graph.facebook.com/${config.INSTAGRAM_GRAPH_API_VERSION}/${target.externalId}`;
  const media = await requestJson<InstagramMedia>(
    fetchImpl,
    `${base}?fields=like_count,comments_count,permalink,timestamp,caption&access_token=${encodeURIComponent(token)}`,
  );
  const views = await instagramReelViews(fetchImpl, base, token);
  upsertVideoSnapshot(backendDb, target.id, "instagram_reels", target.checkpointIndex, {
    title: target.label ?? "Без названия",
    url: media.permalink ?? target.externalUrl,
    publishedAt: media.timestamp ?? target.publishedAt,
    views,
    likes: metricNumber(media.like_count),
    comments: metricNumber(media.comments_count),
  });
  let comments: InstagramComments | null = null;
  try {
    comments = await requestJson<InstagramComments>(
      fetchImpl,
      `${base}/comments?fields=id,text,username,timestamp,like_count&limit=50&access_token=${encodeURIComponent(token)}`,
    );
  } catch {
    // Comment access is optional enrichment just like the Reels play insight.
    // A connected publishing account may publish video without comment-read
    // access, and that must not poison its metrics schedule.
  }
  for (const comment of comments?.data ?? [])
    if (comment.id && comment.text)
      upsertComment(
        backendDb,
        "instagram",
        comment.id,
        target.id,
        comment.text,
        comment.username,
        metricNumber(comment.like_count),
        comment.timestamp,
      );
}

async function instagramReelViews(fetchImpl: typeof fetch, base: string, token: string): Promise<number> {
  try {
    const insights = await requestJson<InstagramInsights>(
      fetchImpl,
      `${base}/insights?metric=plays&access_token=${encodeURIComponent(token)}`,
    );
    return metricNumber(insights.data?.[0]?.values?.[0]?.value);
  } catch {
    // Plays are an optional Reels insight and are not a field on the media
    // object in Graph API v23. Keep likes/comments collection healthy when a
    // connected account does not grant this insight.
    return 0;
  }
}

function isInsufficientYouTubeCommentScope(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /insufficient (authentication )?scopes?|insufficientpermissions|access_token_scope_insufficient/i.test(message);
}
