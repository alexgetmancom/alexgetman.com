import type { BackendDb } from "../../db/client.js";
import { type StudioLocale as BotLocale, localize as ui } from "../../foundation/locale.js";
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
    text: items.length
      ? `📚 ${ui(locale, "Video archive\n\nChoose a video:", "Архив роликов\n\nВыберите ролик:")}`
      : `📚 ${ui(locale, "No published videos yet.", "В архиве пока нет опубликованных роликов.")}`,
    items,
    total,
  };
}
export function creatorVideoMetrics(backendDb: BackendDb, videoDraftId: number, locale: BotLocale = "en"): string {
  const draft = backendDb.sqlite
    .prepare("SELECT COALESCE(label, 'Без названия') AS label FROM video_drafts WHERE id=?")
    .get(videoDraftId) as { label: string } | null;
  if (!draft) return ui(locale, "Video not found.", "Ролик не найден.");
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
      `\n${name}: ${metricNumber(metrics.views)} ${ui(locale, "views", "просмотров")} · ${metricNumber(metrics.likes)} ${ui(locale, "likes", "лайков")} · ${metricNumber(metrics.comments)} ${ui(locale, "comments", "комментариев")}${row.sampled_at ? `\n${ui(locale, "Updated", "Обновлено")}: ${new Date(row.sampled_at).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: "Europe/Moscow" })}` : `\n${ui(locale, "Metrics have not been collected yet.", "Метрики ещё не собраны.")}`}`,
    );
  }
  return lines.join("\n");
}
function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
