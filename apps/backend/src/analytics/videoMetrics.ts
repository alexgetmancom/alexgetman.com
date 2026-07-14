import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { videoDrafts, videoMetricSchedule, videoTargets } from "../db/schema.js";
import { requestJson } from "../delivery/social/http.js";
import { youtubeAccessToken } from "../delivery/video-publishers.js";
import { metricNumber, upsertComment, upsertVideoSnapshot } from "./creatorStore.js";
import { metricCheckpointAt } from "./metric-checkpoints.js";

type VideoMetricTask = {
  id: number;
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
  plays?: number;
  video_views?: number;
  like_count?: number;
  comments_count?: number;
  permalink?: string;
  timestamp?: string;
};
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
      finishVideoMetricTask(backendDb, task, error instanceof Error ? error.message : String(error));
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
        nextCheckAt: metricCheckpointAt(publishedAt.toISOString(), 0, publishedAt)?.toISOString() ?? publishedAt.toISOString(),
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

function finishVideoMetricTask(backendDb: BackendDb, task: VideoMetricTask, error: string | null): void {
  const now = new Date();
  const nextIndex = error ? task.checkpointIndex : task.checkpointIndex + 1;
  const nextCheckAt = error ? new Date(now.getTime() + 15 * 60_000) : metricCheckpointAt(task.publishedAt, nextIndex, now);
  backendDb.db
    .update(videoMetricSchedule)
    .set({
      checkpointIndex: nextIndex,
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
  upsertVideoSnapshot(backendDb, target.id, "youtube_shorts", {
    title: item?.snippet?.title ?? target.label ?? "Без названия",
    url: target.externalUrl,
    publishedAt: item?.snippet?.publishedAt ?? target.publishedAt,
    views: metricNumber(item?.statistics?.viewCount),
    likes: metricNumber(item?.statistics?.likeCount),
    comments: metricNumber(item?.statistics?.commentCount),
  });
  const comments = await requestJson<YouTubeComments>(
    fetchImpl,
    `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(target.externalId)}&maxResults=50&order=time`,
    { headers: auth },
  );
  for (const comment of comments.items ?? []) {
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
    `${base}?fields=plays,like_count,comments_count,permalink,timestamp,caption&access_token=${encodeURIComponent(token)}`,
  );
  upsertVideoSnapshot(backendDb, target.id, "instagram_reels", {
    title: target.label ?? "Без названия",
    url: media.permalink ?? target.externalUrl,
    publishedAt: media.timestamp ?? target.publishedAt,
    views: metricNumber(media.plays ?? media.video_views),
    likes: metricNumber(media.like_count),
    comments: metricNumber(media.comments_count),
  });
  const comments = await requestJson<InstagramComments>(
    fetchImpl,
    `${base}/comments?fields=id,text,username,timestamp,like_count&limit=50&access_token=${encodeURIComponent(token)}`,
  );
  for (const comment of comments.data ?? [])
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
