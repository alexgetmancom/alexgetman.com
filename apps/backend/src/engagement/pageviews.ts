import { eq, or } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { posts } from "../db/schema.js";

export function recordPageview(backendDb: BackendDb, rawPath: string): string {
  const path = normalizeMetricPath(rawPath);
  const now = new Date();
  const day = mskDay(now);
  const candidates = path.endsWith("/") ? [path, path.slice(0, -1)] : [path, `${path}/`];
  const [firstCandidate, secondCandidate] = candidates;
  if (!firstCandidate || !secondCandidate) return path;
  const ru = backendDb.db
    .select({ postKey: posts.postKey })
    .from(posts)
    .where(or(eq(posts.siteRuPath, firstCandidate), eq(posts.siteRuPath, secondCandidate)))
    .get();
  const en = ru
    ? null
    : backendDb.db
        .select({ postKey: posts.postKey })
        .from(posts)
        .where(or(eq(posts.siteEnPath, firstCandidate), eq(posts.siteEnPath, secondCandidate)))
        .get();
  const row = ru ? { postKey: ru.postKey, target: "site_ru" } : en ? { postKey: en.postKey, target: "site_en" } : null;
  const sampledAt = now.toISOString();
  backendDb.sqlite.transaction(() => {
    backendDb.sqlite
      .prepare(
        "INSERT INTO site_pageviews (day, path, count, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(day, path) DO UPDATE SET count=count+1, updated_at=excluded.updated_at",
      )
      .run(day, path, sampledAt);
    if (!row) return;
    const incremented = backendDb.sqlite
      .prepare(
        "INSERT INTO post_metrics (post_key, target, metric_name, value, unit, source, sampled_at, error, raw_json) VALUES (?, ?, 'views', 1, 'count', 'site_pageview_endpoint', ?, NULL, ?) ON CONFLICT(post_key, target, metric_name) DO UPDATE SET value=COALESCE(value,0)+1, source=excluded.source, sampled_at=excluded.sampled_at, error=NULL, raw_json=excluded.raw_json RETURNING value",
      )
      .get(row.postKey, row.target, sampledAt, JSON.stringify({ path })) as { value: number } | null;
    backendDb.sqlite
      .prepare(
        "INSERT INTO metric_samples (post_key, target, metric_name, value, sampled_at, source, raw_json) VALUES (?, ?, 'views', ?, ?, 'site_pageview_endpoint', ?)",
      )
      .run(row.postKey, row.target, Number(incremented?.value ?? 0), sampledAt, JSON.stringify({ path }));
  })();
  return path;
}

export function metricsSummary(backendDb: BackendDb): { total: number; today: number; last7: number; updated_at: unknown } {
  const rows = backendDb.sqlite
    .prepare("SELECT day, sum(count) AS total, max(updated_at) AS updated_at FROM site_pageviews GROUP BY day ORDER BY day DESC")
    .all() as Array<{ day: string; total: number; updated_at: string | null }>;
  const today = mskDay(new Date());
  return {
    total: rows.reduce((sum, row) => sum + Number(row.total), 0),
    today: Number(rows.find((row) => row.day === today)?.total ?? 0),
    last7: rows.slice(0, 7).reduce((sum, row) => sum + Number(row.total), 0),
    updated_at: rows[0]?.updated_at ?? null,
  };
}

function mskDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function normalizeMetricPath(value: string): string {
  let path = String(value || "/")
    .split("#", 1)[0]
    ?.split("?", 1)[0]
    ?.trim();
  if (!path) path = "/";
  if (!path.startsWith("/") || path.startsWith("//")) path = "/";
  if (path.length > 180) path = path.slice(0, 180);
  if (!/^\/[\p{L}A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(path)) path = "/";
  return path || "/";
}
