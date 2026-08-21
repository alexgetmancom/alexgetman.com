import { and, eq, or, sql } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, postLocales } from "../db/schema.js";
import { zonedCalendarDay } from "../foundation/time.js";

export function recordPageview(backendDb: BackendDb, rawPath: string, timeZone = "UTC"): string {
  const path = normalizeMetricPath(rawPath);
  const now = new Date();
  const day = zonedCalendarDay(now, timeZone);
  const candidates = path.endsWith("/") ? [path, path.slice(0, -1)] : [path, `${path}/`];
  const [firstCandidate, secondCandidate] = candidates;
  if (!firstCandidate || !secondCandidate) return path;
  const localePath = (locale: "ru" | "en") =>
    locale === "ru"
      ? sql<string>`'/ru/' || ${drafts.postId} || '/' || ${postLocales.slug} || '/'`
      : sql<string>`'/' || ${drafts.postId} || '/' || ${postLocales.slug} || '/'`;
  const findLocale = (locale: "ru" | "en") =>
    unsafeDb(backendDb)
      .db.select({ postId: drafts.postId })
      .from(drafts)
      .innerJoin(postLocales, and(eq(postLocales.draftId, drafts.id), eq(postLocales.locale, locale), eq(postLocales.siteEnabled, 1)))
      .where(or(eq(localePath(locale), firstCandidate), eq(localePath(locale), secondCandidate)))
      .get();
  const ru = findLocale("ru");
  const en = ru ? null : findLocale("en");
  const row = ru
    ? { publicationKey: publicationRef("post", ru.postId as number), target: "site_ru" }
    : en
      ? { publicationKey: publicationRef("post", en.postId as number), target: "site_en" }
      : null;
  const sampledAt = now.toISOString();
  unsafeDb(backendDb).sqlite.transaction(() => {
    unsafeDb(backendDb)
      .sqlite.prepare(
        "INSERT INTO site_pageviews (day, path, count, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(day, path) DO UPDATE SET count=count+1, updated_at=excluded.updated_at",
      )
      .run(day, path, sampledAt);
    if (!row) return;
    const incremented = unsafeDb(backendDb)
      .sqlite.prepare(
        "INSERT INTO post_metrics (publication_key, target, metric_name, value, unit, source, sampled_at, error, raw_json) VALUES (?, ?, 'views', 1, 'count', 'site_pageview_endpoint', ?, NULL, ?) ON CONFLICT(publication_key, target, metric_name) DO UPDATE SET value=COALESCE(value,0)+1, source=excluded.source, sampled_at=excluded.sampled_at, error=NULL, raw_json=excluded.raw_json RETURNING value",
      )
      .get(row.publicationKey, row.target, sampledAt, JSON.stringify({ path })) as { value: number } | null;
    unsafeDb(backendDb)
      .sqlite.prepare(
        "INSERT INTO metric_samples (publication_key, target, metric_name, value, sampled_at, source) VALUES (?, ?, 'views', ?, ?, 'site_pageview_endpoint')",
      )
      .run(row.publicationKey, row.target, Number(incremented?.value ?? 0), sampledAt);
  })();
  return path;
}

export function metricsSummary(
  backendDb: BackendDb,
  timeZone = "UTC",
): { total: number; today: number; last7: number; updated_at: unknown } {
  const rows = unsafeDb(backendDb)
    .sqlite.prepare("SELECT day, sum(count) AS total, max(updated_at) AS updated_at FROM site_pageviews GROUP BY day ORDER BY day DESC")
    .all() as Array<{ day: string; total: number; updated_at: string | null }>;
  const now = new Date();
  const today = zonedCalendarDay(now, timeZone);
  // Calendar window, not "the 7 most recent rows": days with no traffic have no
  // row at all, and slicing would silently stretch the window across a gap.
  const weekStart = zonedCalendarDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000), timeZone);
  return {
    total: rows.reduce((sum, row) => sum + Number(row.total), 0),
    today: Number(rows.find((row) => row.day === today)?.total ?? 0),
    last7: rows.filter((row) => row.day >= weekStart).reduce((sum, row) => sum + Number(row.total), 0),
    updated_at: rows[0]?.updated_at ?? null,
  };
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
