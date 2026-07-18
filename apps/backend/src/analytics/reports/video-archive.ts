import type { BackendDb } from "../../db/client.js";
import type { StudioLocale as BotLocale } from "../../foundation/locale.js";
import { t } from "../../interfaces/telegram/i18n/index.js";
import { metricNumber } from "../snapshots/creator-store.js";

export function creatorVideoArchive(
  backendDb: BackendDb,
  offset = 0,
  locale: BotLocale = "en",
): {
  text: string;
  items: Array<{ id: number; label: string }>;
  total: number;
} {
  const total = Number(
    (
      backendDb.sqlite.prepare("SELECT COUNT(DISTINCT video_draft_id) AS count FROM video_targets WHERE status='published'").get() as {
        count: number;
      }
    ).count,
  );
  const rows = backendDb.sqlite
    .prepare(
      `SELECT d.id, COALESCE(d.label, 'Без названия') AS label FROM video_drafts d WHERE EXISTS (SELECT 1 FROM video_targets t WHERE t.video_draft_id=d.id AND t.status='published') ORDER BY d.updated_at DESC LIMIT 11 OFFSET ?`,
    )
    .all(offset) as Array<{ id: number; label: string }>;
  const items = rows.slice(0, 10);
  return {
    text: items.length ? `📚 ${t(locale, "report.video-archive-choose")}` : `📚 ${t(locale, "report.no-videos")}`,
    items,
    total,
  };
}
export function creatorVideoMetrics(backendDb: BackendDb, videoDraftId: number, locale: BotLocale = "en"): string {
  const draft = backendDb.sqlite
    .prepare("SELECT COALESCE(label, 'Без названия') AS label FROM video_drafts WHERE id=?")
    .get(videoDraftId) as { label: string } | null;
  if (!draft) return t(locale, "report.video-not-found");
  const rows = backendDb.sqlite
    .prepare(
      `SELECT t.target, t.external_url, s.metrics_json, s.sampled_at FROM video_targets t LEFT JOIN video_metric_snapshots s ON s.id=(SELECT MAX(id) FROM video_metric_snapshots WHERE video_target_id=t.id) WHERE t.video_draft_id=? ORDER BY t.id`,
    )
    .all(videoDraftId) as Array<{
    target: string;
    external_url: string | null;
    metrics_json: string | null;
    sampled_at: string | null;
  }>;
  const lines = [`🎬 *${escapeMarkdown(draft.label)}*`];
  for (const row of rows) {
    const metrics = row.metrics_json ? (JSON.parse(row.metrics_json) as Record<string, unknown>) : {};
    const name = row.target === "youtube_shorts" ? "▶️ YouTube" : "📸 Instagram";
    const expanded =
      row.target === "instagram_reels" && ["reach", "shares", "saves", "follows", "averageWatchTimeMs"].some((key) => metrics[key] != null)
        ? locale === "ru"
          ? `\nохват: ${metricNumber(metrics.reach)} · репосты: ${metricNumber(metrics.shares)} · сохранения: ${metricNumber(metrics.saves)} · подписки: ${metricNumber(metrics.follows)} · среднее: ${(metricNumber(metrics.averageWatchTimeMs) / 1000).toFixed(1)} с`
          : `\nreach: ${metricNumber(metrics.reach)} · shares: ${metricNumber(metrics.shares)} · saves: ${metricNumber(metrics.saves)} · follows: ${metricNumber(metrics.follows)} · avg watch: ${(metricNumber(metrics.averageWatchTimeMs) / 1000).toFixed(1)} s`
        : "";
    lines.push(
      `\n${name}: ${metricNumber(metrics.views)} ${t(locale, "report.views")} · ${metricNumber(metrics.likes)} ${t(locale, "report.likes")} · ${metricNumber(metrics.comments)} ${t(locale, "report.comments")}${expanded}${row.sampled_at ? `\n${t(locale, "report.updated")}: ${new Date(row.sampled_at).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: "Europe/Moscow" })}` : `\n${t(locale, "report.no-metrics")}`}`,
    );
  }
  return lines.join("\n");
}
function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
