import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { Bot } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import {
  analyticsSync,
  creatorProfiles,
  socialComments,
  videoDrafts,
  videoMetricSchedule,
  videoMetricSnapshots,
  videoTargets,
} from "../db/schema.js";
import { metricCheckpointAt } from "../metrics/checkpoints.js";
import { requestJson } from "../social/http.js";
import { youtubeAccessToken } from "../video/publishers.js";

export { audienceAnalysis } from "./audience.js";

const DAILY_SYNC_MS = 24 * 60 * 60_000;

type YouTubeChannel = { items?: Array<{ snippet?: { title?: string }; statistics?: Record<string, string> }> };
type YouTubeVideo = { items?: Array<{ snippet?: { title?: string; publishedAt?: string }; statistics?: Record<string, string> }> };
type YouTubeReport = { columnHeaders?: Array<{ name?: string }>; rows?: Array<Array<string | number>> };
type YouTubeComments = {
  items?: Array<{
    id?: string;
    snippet?: {
      topLevelComment?: {
        snippet?: { textDisplay?: string; authorDisplayName?: string; publishedAt?: string; likeCount?: number };
      };
    };
  }>;
};
type InstagramProfile = { username?: string; biography?: string; followers_count?: number; media_count?: number };
type InstagramMedia = {
  plays?: number;
  video_views?: number;
  like_count?: number;
  comments_count?: number;
  permalink?: string;
  timestamp?: string;
  caption?: string;
};
type InstagramComments = { data?: Array<{ id?: string; text?: string; username?: string; timestamp?: string; like_count?: number }> };

export async function runCreatorAnalyticsCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!config.studio.modules.analytics || !config.studio.modules.video_posting) return 0;
  let synced = 0;
  if (config.studio.modules.youtube && canSync(backendDb, "youtube")) {
    await syncYouTubeProfile(config, backendDb, fetchImpl);
    synced += 1;
  }
  if (config.studio.modules.instagram && canSync(backendDb, "instagram")) {
    await syncInstagramProfile(config, backendDb, fetchImpl);
    synced += 1;
  }
  return synced + (await runVideoMetricSchedule(config, backendDb, fetchImpl));
}

export function creatorDashboard(backendDb: BackendDb, config: BackendConfig, days: number): { text: string; hasComments: boolean } {
  const hasComments = backendDb.db.select({ id: socialComments.commentId }).from(socialComments).limit(1).get() != null;

  if (days === 0) {
    const lines = ["🌐 *Общая статистика*"];
    if (config.studio.modules.youtube) {
      const ytProfile = profile(backendDb, "youtube");
      lines.push("\n🔴 *YouTube (Канал):*");
      if (ytProfile) {
        lines.push(`• Подписчиков: ${number(ytProfile.subscriberCount)}`);
        lines.push(`• Просмотров за все время: ${number(ytProfile.viewCount)}`);
        lines.push(`• Всего видео: ${number(ytProfile.videoCount)}`);
        lines.push(`• За последние 30 дней:`);
        lines.push(`  - Просмотры: ${number(ytProfile.views)}`);
        const watchHours = (number(ytProfile.estimatedMinutesWatched) / 60).toFixed(1);
        lines.push(`  - Время просмотра: ${watchHours} ч.`);
        const gained = number(ytProfile.subscribersGained);
        const lost = number(ytProfile.subscribersLost);
        lines.push(`  - Подписчики: +${gained} / -${lost} (прирост: ${gained - lost})`);
      } else {
        lines.push("• Данные канала еще не синхронизированы.");
      }
    }
    if (config.studio.modules.instagram) {
      const igProfile = profile(backendDb, "instagram");
      lines.push("\n📸 *Instagram (Профиль):*");
      if (igProfile) {
        lines.push(`• Подписчиков: ${number(igProfile.followersCount)}`);
        lines.push(`• Всего Reels/публикаций: ${number(igProfile.mediaCount)}`);
      } else {
        lines.push("• Данные профиля еще не синхронизированы.");
      }
    }
    lines.push("\nДанные обновляются не чаще раза в сутки — это бережно к API платформ.");
    return { text: lines.join("\n"), hasComments };
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const latest = latestVideoMetrics(backendDb, since);
  const lines = [`📊 *Статистика за ${days === 1 ? "сегодня" : `${days} дней`}*`];
  if (config.studio.modules.site) lines.push(`🌐 Сайт: ${siteTotal(backendDb, since)} просмотров материалов`);
  if (config.studio.modules.text_posting) {
    const text = textTotals(backendDb, since);
    lines.push(`📝 Посты: ${text.views} просмотров · ${text.interactions} реакций`);
  }
  if (config.studio.modules.video_posting) {
    const youtube = latest.filter((row) => row.platform === "youtube_shorts");
    const instagram = latest.filter((row) => row.platform === "instagram_reels");
    const all = [...youtube, ...instagram];
    lines.push(`🎬 Видео: ${sum(all, "views")} просмотров · ${sum(all, "likes") + sum(all, "comments")} взаимодействий`);
    if (config.studio.modules.youtube) {
      const profileData = profile(backendDb, "youtube");
      lines.push(
        `YouTube: ${sum(youtube, "views")} просмотров · ${sum(youtube, "likes")} лайков${profileData ? ` · ${number(profileData.subscriberCount)} подписчиков` : ""}`,
      );
    }
    if (config.studio.modules.instagram) {
      const profileData = profile(backendDb, "instagram");
      lines.push(
        `Instagram: ${sum(instagram, "views")} просмотров · ${sum(instagram, "likes")} лайков · ${sum(instagram, "comments")} комментариев${profileData ? ` · ${number(profileData.followersCount)} подписчиков` : ""}`,
      );
    }

    // Group by video label to sum up cross-platform statistics
    const groupedVideos: Record<string, { views: number; likes: number; comments: number }> = {};
    for (const row of latest) {
      const label = row.label || "Без названия";
      if (!groupedVideos[label]) {
        groupedVideos[label] = { views: 0, likes: 0, comments: 0 };
      }
      groupedVideos[label].views += number(row.metrics.views);
      groupedVideos[label].likes += number(row.metrics.likes);
      groupedVideos[label].comments += number(row.metrics.comments);
    }

    const top = Object.entries(groupedVideos)
      .map(([label, metrics]) => ({ label, ...metrics }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 3);

    if (top.length) {
      lines.push("\n🏆 *Топ публикаций (суммарно)*");
      for (const item of top) {
        lines.push(`• ${item.label} — ${number(item.views)} просмотров · ${item.likes} 👍 · ${item.comments} 💬`);
      }
    }
  }
  lines.push("\nДанные обновляются не чаще раза в сутки — это бережно к API платформ.");
  return { text: lines.join("\n"), hasComments };
}

export function creatorVideoArchive(
  backendDb: BackendDb,
  offset = 0,
): { text: string; items: Array<{ id: number; label: string }>; hasMore: boolean } {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT d.id, COALESCE(d.label, 'Без названия') AS label
       FROM video_drafts d WHERE EXISTS (SELECT 1 FROM video_targets t WHERE t.video_draft_id=d.id AND t.status='published')
       ORDER BY d.updated_at DESC LIMIT 11 OFFSET ?`,
    )
    .all(offset) as Array<{ id: number; label: string }>;
  const items = rows.slice(0, 10);
  return {
    text: items.length ? "📚 Архив роликов\n\nВыберите ролик:" : "📚 В архиве пока нет опубликованных роликов.",
    items,
    hasMore: rows.length > items.length,
  };
}

export function creatorVideoMetrics(backendDb: BackendDb, videoDraftId: number): string {
  const draft = backendDb.sqlite
    .prepare("SELECT COALESCE(label, 'Без названия') AS label FROM video_drafts WHERE id=?")
    .get(videoDraftId) as { label: string } | null;
  if (!draft) return "Ролик не найден.";
  const rows = backendDb.sqlite
    .prepare(
      `SELECT t.target, t.external_url, s.metrics_json, s.sampled_at
       FROM video_targets t LEFT JOIN video_metric_snapshots s ON s.id=(SELECT MAX(id) FROM video_metric_snapshots WHERE video_target_id=t.id)
       WHERE t.video_draft_id=? ORDER BY t.id`,
    )
    .all(videoDraftId) as Array<{ target: string; external_url: string | null; metrics_json: string | null; sampled_at: string | null }>;
  const lines = [`🎬 *${escapeMarkdown(draft.label)}*`];
  for (const row of rows) {
    const metrics = row.metrics_json ? (JSON.parse(row.metrics_json) as Record<string, unknown>) : {};
    const name = row.target === "youtube_shorts" ? "▶️ YouTube" : "📸 Instagram";
    lines.push(
      `\n${name}: ${number(metrics.views)} просмотров · ${number(metrics.likes)} лайков · ${number(metrics.comments)} комментариев${row.sampled_at ? `\nОбновлено: ${new Date(row.sampled_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}` : "\nМетрики ещё не собраны."}`,
    );
  }
  return lines.join("\n");
}

/** Sends one creator-summary each Sunday after 21:00 Moscow time. */
export async function runWeeklyCreatorSummary(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
): Promise<boolean> {
  if (!bot || !config.studio.modules.analytics || !config.studio.modules.video_posting) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  if (parts.weekday !== "Sun" || Number(parts.hour) < 21) return false;
  const key = `weekly_summary:${parts.year}-${parts.month}-${parts.day}`;
  if (backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, key)).get()) return false;
  const report = creatorDashboard(backendDb, config, 7).text.replace("📊 *Статистика за 7 дней*", "📊 *Итоги недели*");
  for (const adminId of config.ADMIN_IDS) await bot.api.sendMessage(adminId, report, { parse_mode: "Markdown" });
  markSynced(backendDb, key);
  return true;
}

async function syncYouTubeProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    const token = await youtubeAccessToken(config);
    const auth = { Authorization: `Bearer ${token}` };
    const channel = await requestJson<YouTubeChannel>(
      fetchImpl,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
      { headers: auth },
    );
    const channelItem = channel.items?.[0];
    const period = await youtubeReport(fetchImpl, token);
    upsertProfile(backendDb, "youtube", {
      title: channelItem?.snippet?.title ?? "YouTube",
      subscriberCount: number(channelItem?.statistics?.subscriberCount),
      viewCount: number(channelItem?.statistics?.viewCount),
      videoCount: number(channelItem?.statistics?.videoCount),
      ...period,
    });
    markSynced(backendDb, "youtube");
  } catch (error) {
    markSynced(backendDb, "youtube", error instanceof Error ? error.message : String(error));
  }
}

async function youtubeReport(fetchImpl: typeof fetch, token: string): Promise<Record<string, number>> {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", start);
  url.searchParams.set("endDate", end);
  url.searchParams.set("metrics", "views,likes,comments,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost");
  const report = await requestJson<YouTubeReport>(fetchImpl, url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  return Object.fromEntries(
    (report.columnHeaders ?? []).map((header, index) => [header.name ?? `metric_${index}`, number(report.rows?.[0]?.[index])]),
  );
}

async function syncInstagramProfile(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
  try {
    const token = config.INSTAGRAM_ACCESS_TOKEN;
    const userId = config.INSTAGRAM_USER_ID;
    if (!token || !userId) throw new Error("Instagram credentials are missing");
    const profileData = await requestJson<InstagramProfile>(
      fetchImpl,
      `https://graph.facebook.com/${config.INSTAGRAM_GRAPH_API_VERSION}/${userId}?fields=username,biography,followers_count,media_count&access_token=${encodeURIComponent(token)}`,
    );
    upsertProfile(backendDb, "instagram", {
      username: profileData.username ?? "Instagram",
      biography: profileData.biography ?? "",
      followersCount: number(profileData.followers_count),
      mediaCount: number(profileData.media_count),
    });
    markSynced(backendDb, "instagram");
  } catch (error) {
    markSynced(backendDb, "instagram", error instanceof Error ? error.message : String(error));
  }
}

type VideoMetricTask = {
  id: number;
  target: "youtube_shorts" | "instagram_reels";
  externalId: string;
  externalUrl: string | null;
  publishedAt: string;
  label: string | null;
  checkpointIndex: number;
};

/** Uses the same fixed-from-publication checkpoints as text-post metrics. */
async function runVideoMetricSchedule(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<number> {
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
    views: number(item?.statistics?.viewCount),
    likes: number(item?.statistics?.likeCount),
    comments: number(item?.statistics?.commentCount),
  });
  const comments = await requestJson<YouTubeComments>(
    fetchImpl,
    `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(target.externalId)}&maxResults=50&order=time`,
    { headers: auth },
  );
  for (const comment of comments.items ?? []) {
    const details = comment.snippet?.topLevelComment?.snippet;
    if (!comment.id || !details?.textDisplay) continue;
    upsertComment(
      backendDb,
      "youtube",
      comment.id,
      target.id,
      details.textDisplay,
      details.authorDisplayName,
      number(details.likeCount),
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
    views: number(media.plays ?? media.video_views),
    likes: number(media.like_count),
    comments: number(media.comments_count),
  });
  const comments = await requestJson<InstagramComments>(
    fetchImpl,
    `${base}/comments?fields=id,text,username,timestamp,like_count&limit=50&access_token=${encodeURIComponent(token)}`,
  );
  for (const comment of comments.data ?? []) {
    if (!comment.id || !comment.text) continue;
    upsertComment(
      backendDb,
      "instagram",
      comment.id,
      target.id,
      comment.text,
      comment.username,
      number(comment.like_count),
      comment.timestamp,
    );
  }
}

function upsertComment(
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

function canSync(backendDb: BackendDb, source: string): boolean {
  const row = backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, source)).get();
  return !row || Date.now() - new Date(row.lastSyncedAt).getTime() >= DAILY_SYNC_MS;
}

function markSynced(backendDb: BackendDb, source: string, error: string | null = null): void {
  backendDb.db
    .insert(analyticsSync)
    .values({ source, lastSyncedAt: new Date().toISOString(), lastError: error })
    .onConflictDoUpdate({ target: analyticsSync.source, set: { lastSyncedAt: new Date().toISOString(), lastError: error } })
    .run();
}

function upsertProfile(backendDb: BackendDb, platform: string, data: Record<string, unknown>): void {
  const updatedAt = new Date().toISOString();
  backendDb.db
    .insert(creatorProfiles)
    .values({ platform, dataJson: data, updatedAt })
    .onConflictDoUpdate({ target: creatorProfiles.platform, set: { dataJson: data, updatedAt } })
    .run();
}

function upsertVideoSnapshot(backendDb: BackendDb, videoTargetId: number, platform: string, metrics: Record<string, unknown>): void {
  backendDb.db
    .insert(videoMetricSnapshots)
    .values({ videoTargetId, platform, metricsJson: metrics, sampledAt: new Date().toISOString() })
    .run();
}

function latestVideoMetrics(
  backendDb: BackendDb,
  since: string,
): Array<{ platform: string; label: string; metrics: Record<string, unknown> }> {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT target.target AS platform, draft.label, target.published_at,
              latest.metrics_json AS latest_metrics, latest.sampled_at AS latest_sampled_at,
              baseline.metrics_json AS baseline_metrics
       FROM video_targets target
       JOIN video_drafts draft ON draft.id = target.video_draft_id
       JOIN video_metric_snapshots latest ON latest.id = (
         SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id ORDER BY sampled_at DESC, id DESC LIMIT 1
       )
       LEFT JOIN video_metric_snapshots baseline ON baseline.id = (
         SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id AND sampled_at <= ? ORDER BY sampled_at DESC, id DESC LIMIT 1
       )
       WHERE target.status = 'published'
       ORDER BY latest.id DESC`,
    )
    .all(since) as Array<{
    platform: string;
    label: string;
    published_at: string | null;
    latest_metrics: string;
    latest_sampled_at: string;
    baseline_metrics: string | null;
  }>;
  return rows.flatMap((row) => {
    const latest = JSON.parse(row.latest_metrics) as Record<string, unknown>;
    const baseline = row.baseline_metrics ? (JSON.parse(row.baseline_metrics) as Record<string, unknown>) : null;
    const publishedDuringPeriod = row.published_at != null && row.published_at >= since;
    // For old videos without a checkpoint before the period we cannot infer a
    // delta. Excluding them is preferable to reporting their lifetime totals.
    if (!baseline && !publishedDuringPeriod) return [];
    const metrics = Object.fromEntries(
      Object.entries(latest).map(([key, value]) => [key, Math.max(0, number(value) - number(baseline?.[key]))]),
    );
    return [{ platform: row.platform, label: row.label, metrics }];
  });
}

function profile(backendDb: BackendDb, platform: string): Record<string, unknown> | null {
  return backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, platform)).get()?.dataJson ?? null;
}

function textTotals(backendDb: BackendDb, since: string): { views: number; interactions: number } {
  const totals = metricDeltasSince(backendDb, since, "target NOT LIKE 'site_%'");
  return {
    views: totals.views ?? 0,
    interactions: (totals.likes ?? 0) + (totals.replies ?? 0) + (totals.reposts ?? 0) + (totals.comments ?? 0),
  };
}

function siteTotal(backendDb: BackendDb, since: string): number {
  return metricDeltasSince(backendDb, since, "target LIKE 'site_%'").views ?? 0;
}

function metricDeltasSince(backendDb: BackendDb, since: string, where: string): Record<string, number> {
  const rows = backendDb.sqlite
    .prepare(`SELECT post_key, target, metric_name, value, sampled_at FROM metric_samples WHERE ${where} ORDER BY sampled_at ASC, id ASC`)
    .all() as Array<{ post_key: string; target: string; metric_name: string; value: number | null; sampled_at: string }>;
  const series = new Map<string, { metric: string; firstAt: string; latest: number; baseline: number | null }>();
  for (const row of rows) {
    const key = `${row.post_key}\u0000${row.target}\u0000${row.metric_name}`;
    const value = number(row.value);
    const entry = series.get(key) ?? { metric: row.metric_name, firstAt: row.sampled_at, latest: value, baseline: null };
    entry.latest = value;
    if (row.sampled_at <= since) entry.baseline = value;
    series.set(key, entry);
  }
  const totals: Record<string, number> = {};
  for (const entry of series.values()) {
    if (entry.baseline == null && entry.firstAt < since) continue;
    const delta = Math.max(0, entry.latest - (entry.baseline ?? 0));
    totals[entry.metric] = (totals[entry.metric] ?? 0) + delta;
  }
  return totals;
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function sum(rows: Array<{ metrics: Record<string, unknown> }>, field: string): number {
  return rows.reduce((total, row) => total + number(row.metrics[field]), 0);
}
