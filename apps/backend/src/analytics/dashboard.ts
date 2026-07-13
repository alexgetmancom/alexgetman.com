import { eq } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { creatorProfiles, socialComments } from "../db/schema.js";
import { metricNumber } from "./creatorStore.js";

export function creatorDashboard(backendDb: BackendDb, config: BackendConfig, days: number): { text: string; hasComments: boolean } {
  const hasComments = backendDb.db.select({ id: socialComments.commentId }).from(socialComments).limit(1).get() != null;
  if (days === 0) return overallDashboard(backendDb, config, hasComments);
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const latest = latestVideoMetrics(backendDb, since);
  const lines = [`📊 *Статистика за ${days === 1 ? "сегодня" : `${days} дней`}*`];
  if (config.studio.modules.site) lines.push(`🌐 Сайт: ${siteTotal(backendDb, since)} просмотров материалов`);
  if (config.studio.modules.text_posting) {
    const text = textTotals(backendDb, since);
    lines.push(`📝 Посты: ${text.views} просмотров · ${text.interactions} реакций`);
  }
  if (config.studio.modules.video_posting) appendVideoDashboard(lines, latest, backendDb, config);
  lines.push("\nДанные обновляются не чаще раза в сутки — это бережно к API платформ.");
  return { text: lines.join("\n"), hasComments };
}

function overallDashboard(backendDb: BackendDb, config: BackendConfig, hasComments: boolean): { text: string; hasComments: boolean } {
  const lines = ["🌐 *Общая статистика*"];
  if (config.studio.modules.youtube) {
    const profileData = profile(backendDb, "youtube");
    lines.push("\n🔴 *YouTube (Канал):*");
    if (!profileData) lines.push("• Данные канала еще не синхронизированы.");
    else {
      const gained = metricNumber(profileData.subscribersGained);
      const lost = metricNumber(profileData.subscribersLost);
      lines.push(
        `• Подписчиков: ${metricNumber(profileData.subscriberCount)}`,
        `• Просмотров за все время: ${metricNumber(profileData.viewCount)}`,
        `• Всего видео: ${metricNumber(profileData.videoCount)}`,
        "• За последние 30 дней:",
        `  - Просмотры: ${metricNumber(profileData.views)}`,
        `  - Время просмотра: ${(metricNumber(profileData.estimatedMinutesWatched) / 60).toFixed(1)} ч.`,
        `  - Подписчики: +${gained} / -${lost} (прирост: ${gained - lost})`,
      );
    }
  }
  if (config.studio.modules.instagram) {
    const profileData = profile(backendDb, "instagram");
    lines.push("\n📸 *Instagram (Профиль):*");
    if (!profileData) lines.push("• Данные профиля еще не синхронизированы.");
    else
      lines.push(
        `• Подписчиков: ${metricNumber(profileData.followersCount)}`,
        `• Всего Reels/публикаций: ${metricNumber(profileData.mediaCount)}`,
      );
  }
  lines.push("\nДанные обновляются не чаще раза в сутки — это бережно к API платформ.");
  return { text: lines.join("\n"), hasComments };
}

function appendVideoDashboard(lines: string[], latest: VideoMetricRow[], backendDb: BackendDb, config: BackendConfig): void {
  const youtube = latest.filter((row) => row.platform === "youtube_shorts");
  const instagram = latest.filter((row) => row.platform === "instagram_reels");
  const all = [...youtube, ...instagram];
  lines.push(`🎬 Видео: ${sum(all, "views")} просмотров · ${sum(all, "likes") + sum(all, "comments")} взаимодействий`);
  if (config.studio.modules.youtube) {
    const data = profile(backendDb, "youtube");
    lines.push(
      `YouTube: ${sum(youtube, "views")} просмотров · ${sum(youtube, "likes")} лайков${data ? ` · ${metricNumber(data.subscriberCount)} подписчиков` : ""}`,
    );
  }
  if (config.studio.modules.instagram) {
    const data = profile(backendDb, "instagram");
    lines.push(
      `Instagram: ${sum(instagram, "views")} просмотров · ${sum(instagram, "likes")} лайков · ${sum(instagram, "comments")} комментариев${data ? ` · ${metricNumber(data.followersCount)} подписчиков` : ""}`,
    );
  }
  const grouped: Record<string, { views: number; likes: number; comments: number }> = {};
  for (const row of latest) {
    const label = row.label || "Без названия";
    const item = grouped[label] ?? { views: 0, likes: 0, comments: 0 };
    item.views += metricNumber(row.metrics.views);
    item.likes += metricNumber(row.metrics.likes);
    item.comments += metricNumber(row.metrics.comments);
    grouped[label] = item;
  }
  const top = Object.entries(grouped)
    .map(([label, metrics]) => ({ label, ...metrics }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 3);
  if (top.length) {
    lines.push("\n🏆 *Топ публикаций (суммарно)*");
    for (const item of top) lines.push(`• ${item.label} — ${metricNumber(item.views)} просмотров · ${item.likes} 👍 · ${item.comments} 💬`);
  }
}

type VideoMetricRow = {
  platform: string;
  label: string;
  metrics: Record<string, unknown>;
};
function latestVideoMetrics(backendDb: BackendDb, since: string): VideoMetricRow[] {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT target.target AS platform, draft.label, target.published_at, latest.metrics_json AS latest_metrics, baseline.metrics_json AS baseline_metrics FROM video_targets target JOIN video_drafts draft ON draft.id = target.video_draft_id JOIN video_metric_snapshots latest ON latest.id = (SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id ORDER BY sampled_at DESC, id DESC LIMIT 1) LEFT JOIN video_metric_snapshots baseline ON baseline.id = (SELECT id FROM video_metric_snapshots WHERE video_target_id = target.id AND sampled_at <= ? ORDER BY sampled_at DESC, id DESC LIMIT 1) WHERE target.status = 'published' ORDER BY latest.id DESC`,
    )
    .all(since) as Array<{
    platform: string;
    label: string;
    published_at: string | null;
    latest_metrics: string;
    baseline_metrics: string | null;
  }>;
  return rows.flatMap((row) => {
    const latest = JSON.parse(row.latest_metrics) as Record<string, unknown>;
    const baseline = row.baseline_metrics ? (JSON.parse(row.baseline_metrics) as Record<string, unknown>) : null;
    if (!baseline && !(row.published_at != null && row.published_at >= since)) return [];
    const metrics = Object.fromEntries(
      Object.entries(latest).map(([key, value]) => [key, Math.max(0, metricNumber(value) - metricNumber(baseline?.[key]))]),
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
    .all() as Array<{
    post_key: string;
    target: string;
    metric_name: string;
    value: number | null;
    sampled_at: string;
  }>;
  const series = new Map<string, { metric: string; firstAt: string; latest: number; baseline: number | null }>();
  for (const row of rows) {
    const key = `${row.post_key}\u0000${row.target}\u0000${row.metric_name}`;
    const value = metricNumber(row.value);
    const entry = series.get(key) ?? {
      metric: row.metric_name,
      firstAt: row.sampled_at,
      latest: value,
      baseline: null,
    };
    entry.latest = value;
    if (row.sampled_at <= since) entry.baseline = value;
    series.set(key, entry);
  }
  const totals: Record<string, number> = {};
  for (const entry of series.values()) {
    if (entry.baseline == null && entry.firstAt < since) continue;
    totals[entry.metric] = (totals[entry.metric] ?? 0) + Math.max(0, entry.latest - (entry.baseline ?? 0));
  }
  return totals;
}
function sum(rows: VideoMetricRow[], field: string): number {
  return rows.reduce((total, row) => total + metricNumber(row.metrics[field]), 0);
}
