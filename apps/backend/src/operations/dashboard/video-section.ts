import { metricNumber } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import { formatMetricValue } from "./format.js";
import { escapeHtml } from "./html.js";

type VideoTarget = {
  target: string;
  status: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  lastError: string | null;
  metricsJson: string | null;
};

type VideoRow = { id: number; label: string; createdAt: string; scheduledAt: string | null; targets: VideoTarget[] };

/** Operations read-model for the Video Studio. It uses only durable video and
 * analytics snapshots; the Telegram conversation is not part of this view. */
export function renderVideoSection(backendDb: BackendDb): string {
  const rows = videoRows(backendDb);
  const trend = videoTrend(backendDb);
  const totals = rows.reduce(
    (total, row) => {
      for (const target of row.targets) {
        const metrics = targetMetrics(target);
        total.views += metrics.views;
        total.likes += metrics.likes;
        total.comments += metrics.comments;
        if (target.status === "scheduled" || target.status === "prepared") total.scheduled += 1;
        if (target.status === "failed") total.failed += 1;
      }
      return total;
    },
    { views: 0, likes: 0, comments: 0, scheduled: 0, failed: 0 },
  );
  const audience = videoAudience(backendDb);
  const cards = [
    stat("Просмотры", totals.views),
    stat("Лайки", totals.likes),
    stat("Комментарии", totals.comments),
    stat("В очереди", totals.scheduled),
    ...(totals.failed ? [stat("Ошибки", totals.failed, "danger")] : []),
    ...audience.map((item) =>
      stat(
        `${item.label} · подписчики`,
        item.followers,
        item.growth == null ? undefined : item.growth >= 0 ? `+${item.growth} за 7д` : `${item.growth} за 7д`,
      ),
    ),
  ].join("");
  const tableRows = rows.length
    ? rows.map((row) => renderVideoRow(row)).join("")
    : '<tr><td colspan="6" class="note">Роликов пока нет.</td></tr>';
  return `<section id="video" class="video-dashboard"><div class="grid video-stats">${cards}</div>${renderVideoChart(trend)}<div class="table-wrap"><table><thead><tr><th>Видео</th><th>Создано</th><th>План</th><th>▶️ YouTube</th><th>📸 Instagram</th><th>Σ</th></tr></thead><tbody>${tableRows}</tbody></table></div><p class="note">Подписчики — снимки канала/профиля. Их прирост показан рядом с роликами по времени, но API не позволяет честно приписать конкретного подписчика одному ролику.</p></section>`;
}

function videoRows(backendDb: BackendDb): VideoRow[] {
  const drafts = backendDb.sqlite
    .prepare(
      "SELECT id, COALESCE(label, 'Без названия') AS label, created_at AS createdAt, scheduled_at AS scheduledAt FROM video_drafts ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 100",
    )
    .all() as Array<{ id: number; label: string; createdAt: string; scheduledAt: string | null }>;
  const targets = backendDb.sqlite
    .prepare(
      `SELECT t.video_draft_id AS videoDraftId, t.target, t.status, t.scheduled_at AS scheduledAt, t.published_at AS publishedAt, t.external_url AS externalUrl, t.last_error AS lastError, s.metrics_json AS metricsJson
       FROM video_targets t
       LEFT JOIN video_metric_snapshots s ON s.id=(SELECT id FROM video_metric_snapshots WHERE video_target_id=t.id ORDER BY sampled_at DESC, id DESC LIMIT 1)
       ORDER BY t.video_draft_id, t.id`,
    )
    .all() as Array<VideoTarget & { videoDraftId: number }>;
  const byDraft = new Map<number, VideoTarget[]>();
  for (const target of targets) {
    const list = byDraft.get(target.videoDraftId) ?? [];
    list.push(target);
    byDraft.set(target.videoDraftId, list);
  }
  return drafts.map((draft) => ({ ...draft, targets: byDraft.get(draft.id) ?? [] }));
}

function renderVideoRow(row: VideoRow): string {
  const youtube = row.targets.find((target) => target.target === "youtube_shorts");
  const instagram = row.targets.find((target) => target.target === "instagram_reels");
  const total = [youtube, instagram]
    .filter((target): target is VideoTarget => Boolean(target))
    .reduce((value, target) => value + targetMetrics(target).views, 0);
  return `<tr><td><b>#${row.id}</b> ${escapeHtml(row.label)}</td><td class="nowrap">${formatDate(row.createdAt)}</td><td class="nowrap">${formatDate(row.scheduledAt)}</td><td>${renderTarget(youtube)}</td><td>${renderTarget(instagram)}</td><td class="font-bold">${formatMetricValue(total)}</td></tr>`;
}

function renderTarget(target: VideoTarget | undefined): string {
  if (!target) return "—";
  if (target.status === "failed") return `<span class="danger">Ошибка</span><br><small>${escapeHtml(target.lastError ?? "")}</small>`;
  if (target.status === "scheduled" || target.status === "prepared") return `⏳ ${formatDate(target.scheduledAt)}`;
  if (target.status !== "published") return escapeHtml(target.status);
  const metrics = targetMetrics(target);
  const title = `${formatMetricValue(metrics.views)} views · ${formatMetricValue(metrics.likes)} likes · ${formatMetricValue(metrics.comments)} comments`;
  const value = `<b>${formatMetricValue(metrics.views)}</b><br><small>♥ ${formatMetricValue(metrics.likes)} · 💬 ${formatMetricValue(metrics.comments)}</small>`;
  return target.externalUrl
    ? `<a href="${escapeHtml(target.externalUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(title)}">${value}</a>`
    : value;
}

function targetMetrics(target: VideoTarget): { views: number; likes: number; comments: number } {
  const metrics = target.metricsJson ? (JSON.parse(target.metricsJson) as Record<string, unknown>) : {};
  return { views: metricNumber(metrics.views), likes: metricNumber(metrics.likes), comments: metricNumber(metrics.comments) };
}

function videoAudience(backendDb: BackendDb): Array<{ label: string; followers: number; growth: number | null }> {
  const profiles = backendDb.sqlite
    .prepare(
      "SELECT platform, metrics_json AS metricsJson FROM creator_profile_snapshots WHERE id IN (SELECT MAX(id) FROM creator_profile_snapshots WHERE platform IN ('youtube','instagram') GROUP BY platform, account)",
    )
    .all() as Array<{ platform: string; metricsJson: string }>;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  return profiles.map((profile) => {
    const latest = JSON.parse(profile.metricsJson) as Record<string, unknown>;
    const baseline = backendDb.sqlite
      .prepare(
        "SELECT metrics_json AS metricsJson FROM creator_profile_snapshots WHERE platform=? AND sampled_at<=? ORDER BY sampled_at DESC, id DESC LIMIT 1",
      )
      .get(profile.platform, since) as { metricsJson: string } | null;
    const followers = metricNumber(latest.subscriberCount ?? latest.followersCount);
    const previousMetrics = baseline ? (JSON.parse(baseline.metricsJson) as Record<string, unknown>) : null;
    const previous = previousMetrics ? metricNumber(previousMetrics.subscriberCount ?? previousMetrics.followersCount) : null;
    return {
      label: profile.platform === "youtube" ? "YouTube" : "Instagram",
      followers,
      growth: previous == null ? null : followers - previous,
    };
  });
}

type VideoTrendPoint = { day: string; views: number; likes: number; comments: number };

/** Retains the last snapshot of every video target for each observed day. This
 * makes the chart cumulative instead of dropping a Reel on days the API did not
 * return a fresh sample.
 *
 * Bounded to a 30-day window: a `baseline` query seeds each target's latest
 * value as of the window start, so the full snapshot history never needs a
 * full-table scan on every render. */
function videoTrend(backendDb: BackendDb): VideoTrendPoint[] {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const baseline = backendDb.sqlite
    .prepare(
      `SELECT video_target_id AS targetId, metrics_json AS metricsJson
       FROM video_metric_snapshots
       WHERE id IN (SELECT MAX(id) FROM video_metric_snapshots WHERE sampled_at < ? GROUP BY video_target_id)`,
    )
    .all(cutoff) as Array<{ targetId: number; metricsJson: string }>;
  const samples = backendDb.sqlite
    .prepare(
      "SELECT video_target_id AS targetId, metrics_json AS metricsJson, sampled_at AS sampledAt FROM video_metric_snapshots WHERE sampled_at >= ? ORDER BY sampled_at ASC, id ASC",
    )
    .all(cutoff) as Array<{ targetId: number; metricsJson: string; sampledAt: string }>;
  const latest = new Map<number, { views: number; likes: number; comments: number }>();
  for (const row of baseline) latest.set(row.targetId, targetMetrics({ metricsJson: row.metricsJson } as VideoTarget));
  const points = new Map<string, VideoTrendPoint>();
  for (const sample of samples) {
    latest.set(sample.targetId, targetMetrics({ metricsJson: sample.metricsJson } as VideoTarget));
    const day = sample.sampledAt.slice(0, 10);
    points.set(day, {
      day,
      views: sumMetrics(latest, "views"),
      likes: sumMetrics(latest, "likes"),
      comments: sumMetrics(latest, "comments"),
    });
  }
  return [...points.values()].slice(-30);
}

function sumMetrics(
  metrics: Map<number, { views: number; likes: number; comments: number }>,
  field: "views" | "likes" | "comments",
): number {
  return [...metrics.values()].reduce((total, value) => total + value[field], 0);
}

function renderVideoChart(points: VideoTrendPoint[]): string {
  if (points.length < 2) return '<p class="note video-chart-note">График появится после двух снимков метрик.</p>';
  const width = 960;
  const height = 180;
  const pad = { x: 16, y: 16 };
  const max = Math.max(1, ...points.flatMap((point) => [point.views, point.likes, point.comments]));
  const x = (index: number) => pad.x + (index * (width - pad.x * 2)) / Math.max(1, points.length - 1);
  const y = (value: number) => height - pad.y - (value / max) * (height - pad.y * 2);
  const line = (field: "views" | "likes" | "comments") =>
    points.map((point, index) => `${x(index).toFixed(1)},${y(point[field]).toFixed(1)}`).join(" ");
  const labels = (points.length > 6 ? [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]] : points).filter(
    (point): point is VideoTrendPoint => point != null,
  );
  return `<div class="metric-chart video-chart"><div class="metric-chart__legend"><span><i style="background:#58a6ff"></i>Просмотры</span><span><i style="background:#f778ba"></i>Лайки</span><span><i style="background:#a5d6ff"></i>Комментарии</span></div><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Динамика метрик роликов"><line class="chart-grid" x1="${pad.x}" y1="${height / 2}" x2="${width - pad.x}" y2="${height / 2}"/><line class="chart-grid" x1="${pad.x}" y1="${height - pad.y}" x2="${width - pad.x}" y2="${height - pad.y}"/><polyline fill="none" stroke="#58a6ff" stroke-width="2" class="chart-line" points="${line("views")}"/><polyline fill="none" stroke="#f778ba" stroke-width="2" class="chart-line" points="${line("likes")}"/><polyline fill="none" stroke="#a5d6ff" stroke-width="2" class="chart-line" points="${line("comments")}"/></svg><div class="video-chart-labels">${labels.map((point) => `<span>${escapeHtml(point.day.slice(5))}</span>`).join("")}</div></div>`;
}

function stat(label: string, value: number, note?: string): string {
  return `<div class="stat"><small>${escapeHtml(label)}</small><span>${formatMetricValue(value)}</span>${note ? `<small class="note">${escapeHtml(note)}</small>` : ""}</div>`;
}
function formatDate(value: string | null): string {
  return value
    ? new Date(value).toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}
