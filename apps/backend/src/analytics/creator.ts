import { and, eq } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { analyticsSync, creatorProfiles, socialComments, videoDrafts, videoMetricSnapshots, videoTargets } from "../db/schema.js";
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
type InstagramMedia = { like_count?: number; comments_count?: number; permalink?: string; timestamp?: string; caption?: string };
type InstagramComments = { data?: Array<{ id?: string; text?: string; username?: string; timestamp?: string; like_count?: number }> };

export async function runCreatorAnalyticsCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!config.studio.modules.analytics || !config.studio.modules.video_posting) return 0;
  let synced = 0;
  if (config.studio.modules.youtube && canSync(backendDb, "youtube")) {
    await syncYouTube(config, backendDb, fetchImpl);
    synced += 1;
  }
  if (config.studio.modules.instagram && canSync(backendDb, "instagram")) {
    await syncInstagram(config, backendDb, fetchImpl);
    synced += 1;
  }
  return synced;
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
  if (config.studio.modules.site) lines.push(`🌐 Сайт: ${siteTotal(backendDb)} просмотров материалов`);
  if (config.studio.modules.text_posting)
    lines.push(`📝 Посты: ${textTotals(backendDb).views} просмотров · ${textTotals(backendDb).interactions} реакций`);
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

async function syncYouTube(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
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
    const targets = publishedTargets(backendDb, "youtube_shorts");
    for (const target of targets) {
      const video = await requestJson<YouTubeVideo>(
        fetchImpl,
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(target.externalId)}`,
        {
          headers: auth,
        },
      );
      const item = video.items?.[0];
      upsertVideoSnapshot(backendDb, target.id, "youtube_shorts", {
        title: item?.snippet?.title ?? target.label,
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
        backendDb.db
          .insert(socialComments)
          .values({
            platform: "youtube",
            commentId: comment.id,
            videoTargetId: target.id,
            author: details.authorDisplayName ?? null,
            text: details.textDisplay,
            likeCount: number(details.likeCount),
            publishedAt: details.publishedAt ?? null,
            fetchedAt: new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: [socialComments.platform, socialComments.commentId],
            set: { text: details.textDisplay, likeCount: number(details.likeCount), fetchedAt: new Date().toISOString() },
          })
          .run();
      }
    }
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

async function syncInstagram(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch): Promise<void> {
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
    for (const target of publishedTargets(backendDb, "instagram_reels")) {
      const base = `https://graph.facebook.com/${config.INSTAGRAM_GRAPH_API_VERSION}/${target.externalId}`;
      const media = await requestJson<InstagramMedia>(
        fetchImpl,
        `${base}?fields=like_count,comments_count,permalink,timestamp,caption&access_token=${encodeURIComponent(token)}`,
      );
      upsertVideoSnapshot(backendDb, target.id, "instagram_reels", {
        title: target.label,
        url: media.permalink ?? target.externalUrl,
        publishedAt: media.timestamp ?? target.publishedAt,
        likes: number(media.like_count),
        comments: number(media.comments_count),
      });
      const comments = await requestJson<InstagramComments>(
        fetchImpl,
        `${base}/comments?fields=id,text,username,timestamp,like_count&limit=50&access_token=${encodeURIComponent(token)}`,
      );
      for (const comment of comments.data ?? []) {
        if (!comment.id || !comment.text) continue;
        backendDb.db
          .insert(socialComments)
          .values({
            platform: "instagram",
            commentId: comment.id,
            videoTargetId: target.id,
            author: comment.username ?? null,
            text: comment.text,
            likeCount: number(comment.like_count),
            publishedAt: comment.timestamp ?? null,
            fetchedAt: new Date().toISOString(),
          })
          .onConflictDoUpdate({
            target: [socialComments.platform, socialComments.commentId],
            set: { text: comment.text, likeCount: number(comment.like_count), fetchedAt: new Date().toISOString() },
          })
          .run();
      }
    }
    markSynced(backendDb, "instagram");
  } catch (error) {
    markSynced(backendDb, "instagram", error instanceof Error ? error.message : String(error));
  }
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

function publishedTargets(backendDb: BackendDb, platform: "youtube_shorts" | "instagram_reels") {
  return backendDb.db
    .select({
      id: videoTargets.id,
      externalId: videoTargets.externalId,
      externalUrl: videoTargets.externalUrl,
      publishedAt: videoTargets.publishedAt,
      label: videoDrafts.label,
    })
    .from(videoTargets)
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .where(and(eq(videoTargets.target, platform), eq(videoTargets.status, "published")))
    .all()
    .filter((target): target is typeof target & { externalId: string } => Boolean(target.externalId));
}

function latestVideoMetrics(
  backendDb: BackendDb,
  since: string,
): Array<{ platform: string; label: string; metrics: Record<string, unknown> }> {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT snapshot.platform, snapshot.metrics_json, draft.label
       FROM video_metric_snapshots snapshot
       JOIN video_drafts draft ON draft.id = (SELECT video_draft_id FROM video_targets WHERE id = snapshot.video_target_id)
       WHERE snapshot.sampled_at >= ?
       AND snapshot.id IN (SELECT MAX(id) FROM video_metric_snapshots WHERE sampled_at >= ? GROUP BY video_target_id)
       ORDER BY snapshot.id DESC`,
    )
    .all(since, since) as Array<{ platform: string; metrics_json: string; label: string }>;
  return rows.map((row) => ({
    platform: row.platform,
    label: row.label,
    metrics: JSON.parse(row.metrics_json) as Record<string, unknown>,
  }));
}

function profile(backendDb: BackendDb, platform: string): Record<string, unknown> | null {
  return backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, platform)).get()?.dataJson ?? null;
}

function textTotals(backendDb: BackendDb): { views: number; interactions: number } {
  const row = backendDb.sqlite
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN metric_name='views' THEN value END),0) AS views, COALESCE(SUM(CASE WHEN metric_name IN ('likes','replies','reposts','comments') THEN value END),0) AS interactions FROM post_metrics",
    )
    .get() as { views: number; interactions: number };
  return row;
}

function siteTotal(backendDb: BackendDb): number {
  const row = backendDb.sqlite
    .prepare("SELECT COALESCE(SUM(value),0) AS total FROM post_metrics WHERE target='telegram' AND metric_name='views'")
    .get() as { total: number };
  return row.total;
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
