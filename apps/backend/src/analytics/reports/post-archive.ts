import type { BackendDb } from "../../db/client.js";
import type { StudioLocale as BotLocale } from "../../foundation/locale.js";
import { t } from "../../interfaces/telegram/i18n/index.js";
import { metricNumber } from "../snapshots/creator-store.js";

export function creatorPostArchive(
  backendDb: BackendDb,
  offset = 0,
  locale: BotLocale = "en",
): { text: string; items: Array<{ id: number; label: string }>; total: number } {
  const total = Number(
    (
      backendDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM posts p JOIN publications pub ON pub.post_id=p.post_id WHERE pub.status='published'")
        .get() as {
        count: number;
      }
    ).count,
  );
  const rows = backendDb.sqlite
    .prepare(
      `SELECT p.post_id AS id, COALESCE(NULLIF(trim(p.text), ''), 'Media post') AS label FROM posts p JOIN publications pub ON pub.post_id=p.post_id WHERE pub.status='published' ORDER BY p.updated_at DESC LIMIT 11 OFFSET ?`,
    )
    .all(offset) as Array<{ id: number; label: string }>;
  const items = rows.slice(0, 10).map((item) => ({ ...item, label: item.label.replace(/\s+/g, " ").slice(0, 42) }));
  return {
    text: items.length ? `📚 ${t(locale, "report.post-archive-choose")}` : `📚 ${t(locale, "report.no-posts")}`,
    items,
    total,
  };
}

export function creatorPostMetrics(backendDb: BackendDb, postId: number, locale: BotLocale = "en"): string {
  const post = backendDb.sqlite.prepare("SELECT text, media_count, date_msk FROM posts WHERE post_id=?").get(postId) as {
    text: string | null;
    media_count: number;
    date_msk: string | null;
  } | null;
  if (!post) return t(locale, "report.post-not-found");
  const rows = backendDb.sqlite
    .prepare(
      `SELECT target, metric_name, value FROM metric_samples WHERE post_key=? AND id IN (SELECT MAX(id) FROM metric_samples WHERE post_key=? GROUP BY target, metric_name) ORDER BY target, metric_name`,
    )
    .all(`post:${postId}`, `post:${postId}`) as Array<{ target: string; metric_name: string; value: number | null }>;
  const metrics = new Map<string, Record<string, number>>();
  for (const row of rows) metrics.set(row.target, { ...(metrics.get(row.target) ?? {}), [row.metric_name]: metricNumber(row.value) });
  const totals = [...metrics.values()].reduce<{ views: number; interactions: number }>(
    (total, values) => ({
      views: total.views + (values.views ?? 0),
      interactions: total.interactions + (values.likes ?? 0) + (values.replies ?? 0) + (values.comments ?? 0) + (values.reposts ?? 0),
    }),
    { views: 0, interactions: 0 },
  );
  const lines = [
    `📝 *${t(locale, "report.post-heading", { id: postId })}*`,
    `👁 ${t(locale, "report.total-views")}: *${totals.views}*`,
    `💬 ${t(locale, "report.interactions")}: *${totals.interactions}*`,
    `🖼 ${t(locale, "report.media")}: *${post.media_count}*`,
    post.date_msk ? `🗓 ${post.date_msk}` : "",
    "",
    post.text?.slice(0, 600) || t(locale, "report.media-post"),
  ].filter(Boolean);
  for (const [target, values] of metrics)
    lines.push(
      `\n${target}: ${values.views ?? 0} ${t(locale, "report.views")} · ${(values.likes ?? 0) + (values.replies ?? 0) + (values.comments ?? 0)} ${t(locale, "report.interactions-lc")}`,
    );
  return lines.join("\n");
}

/** Published locale media is returned as data; the Telegram adapter decides how
 * to render it, so archive previews do not leak transport details into Analytics. */
export function creatorPostMedia(backendDb: BackendDb, postId: number, locale: BotLocale): Record<string, unknown>[] {
  const preferred = locale === "ru" ? "ru" : "en";
  const row = backendDb.sqlite.prepare("SELECT media_json FROM post_locales WHERE post_id=? AND locale=?").get(postId, preferred) as {
    media_json: string | null;
  } | null;
  try {
    const media = row?.media_json ? JSON.parse(row.media_json) : [];
    return Array.isArray(media) ? media.filter((item): item is Record<string, unknown> => item != null && typeof item === "object") : [];
  } catch {
    return [];
  }
}

export function creatorArchiveSummary(
  backendDb: BackendDb,
  hasVideo: boolean,
  locale: BotLocale = "en",
): {
  text: string;
  posts: number;
  videos: number;
} {
  const posts = Number(
    (
      backendDb.sqlite
        .prepare("SELECT COUNT(*) AS count FROM posts p JOIN publications pub ON pub.post_id=p.post_id WHERE pub.status='published'")
        .get() as {
        count: number;
      }
    ).count,
  );
  const videos = hasVideo
    ? Number(
        (
          backendDb.sqlite.prepare("SELECT COUNT(DISTINCT video_draft_id) AS count FROM video_targets WHERE status='published'").get() as {
            count: number;
          }
        ).count,
      )
    : 0;
  return {
    text: [
      `📚 *${t(locale, "report.archive-title")}*`,
      "",
      t(locale, "report.archive-desc"),
      `${t(locale, "report.posts")}: *${posts}*`,
      hasVideo ? `${t(locale, "report.videos")}: *${videos}*` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    posts,
    videos,
  };
}
