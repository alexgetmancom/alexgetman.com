import type { BackendDb } from "../db/client.js";
import { metricNumber } from "./creatorStore.js";

export function creatorVideoArchive(
  backendDb: BackendDb,
  offset = 0,
): {
  text: string;
  items: Array<{ id: number; label: string }>;
  hasMore: boolean;
} {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT d.id, COALESCE(d.label, 'Без названия') AS label FROM video_drafts d WHERE EXISTS (SELECT 1 FROM video_targets t WHERE t.video_draft_id=d.id AND t.status='published') ORDER BY d.updated_at DESC LIMIT 11 OFFSET ?`,
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
    lines.push(
      `\n${name}: ${metricNumber(metrics.views)} просмотров · ${metricNumber(metrics.likes)} лайков · ${metricNumber(metrics.comments)} комментариев${row.sampled_at ? `\nОбновлено: ${new Date(row.sampled_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}` : "\nМетрики ещё не собраны."}`,
    );
  }
  return lines.join("\n");
}
function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
