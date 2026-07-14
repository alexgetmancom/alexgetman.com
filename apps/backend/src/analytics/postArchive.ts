import type { BackendDb } from "../db/client.js";
import { type StudioLocale as BotLocale, localize as ui } from "../studio/locale.js";
import { metricNumber } from "./creatorStore.js";

export function creatorPostArchive(
  backendDb: BackendDb,
  offset = 0,
  locale: BotLocale = "en",
): { text: string; items: Array<{ id: number; label: string }>; hasMore: boolean } {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT p.post_id AS id, COALESCE(NULLIF(trim(p.text), ''), 'Media post') AS label FROM posts p JOIN publications pub ON pub.post_id=p.post_id WHERE pub.status='published' ORDER BY p.updated_at DESC LIMIT 11 OFFSET ?`,
    )
    .all(offset) as Array<{ id: number; label: string }>;
  const items = rows.slice(0, 10).map((item) => ({ ...item, label: item.label.replace(/\s+/g, " ").slice(0, 42) }));
  return {
    text: items.length
      ? `📚 ${ui(locale, "Post archive\n\nChoose a post:", "Архив постов\n\nВыберите пост:")}`
      : `📚 ${ui(locale, "No published posts yet.", "В архиве пока нет опубликованных постов.")}`,
    items,
    hasMore: rows.length > items.length,
  };
}

export function creatorPostMetrics(backendDb: BackendDb, postId: number, locale: BotLocale = "en"): string {
  const post = backendDb.sqlite.prepare("SELECT text FROM posts WHERE post_id=?").get(postId) as { text: string | null } | null;
  if (!post) return ui(locale, "Post not found.", "Пост не найден.");
  const rows = backendDb.sqlite
    .prepare(
      `SELECT target, metric_name, value FROM metric_samples WHERE post_key=? AND id IN (SELECT MAX(id) FROM metric_samples WHERE post_key=? GROUP BY target, metric_name) ORDER BY target, metric_name`,
    )
    .all(`post:${postId}`, `post:${postId}`) as Array<{ target: string; metric_name: string; value: number | null }>;
  const metrics = new Map<string, Record<string, number>>();
  for (const row of rows) metrics.set(row.target, { ...(metrics.get(row.target) ?? {}), [row.metric_name]: metricNumber(row.value) });
  const lines = [
    `📝 *${ui(locale, `Post #${postId}`, `Пост #${postId}`)}*`,
    post.text?.slice(0, 600) || ui(locale, "[media post]", "[пост с медиа]"),
  ];
  for (const [target, values] of metrics)
    lines.push(
      `\n${target}: ${values.views ?? 0} ${ui(locale, "views", "просмотров")} · ${(values.likes ?? 0) + (values.replies ?? 0) + (values.comments ?? 0)} ${ui(locale, "interactions", "реакций")}`,
    );
  return lines.join("\n");
}
