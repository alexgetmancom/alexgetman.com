import crypto from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { likes, posts } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";

/** Public-site engagement use cases, isolated from Studio and Operations. */
export function likesInfo(backendDb: BackendDb, postId: string, clientHash: string): { likes: number; user_liked: boolean } {
  const count = backendDb.db.select({ count: sql<number>`count(*)` }).from(likes).where(eq(likes.postId, postId)).get();
  const liked = backendDb.db
    .select({ postId: likes.postId })
    .from(likes)
    .where(and(eq(likes.postId, postId), eq(likes.ipHash, clientHash)))
    .get();
  return { likes: Number(count?.count ?? 0), user_liked: Boolean(liked) };
}

export function batchLikes(
  backendDb: BackendDb,
  postIds: string[],
  clientHash: string,
): Record<string, { likes: number; user_liked: boolean }> {
  if (postIds.length === 0) return {};
  const unique = [...new Set(postIds)];
  const rows = backendDb.db
    .select({
      postId: likes.postId,
      count: sql<number>`count(*)`,
      userLiked: sql<number>`max(case when ${likes.ipHash} = ${clientHash} then 1 else 0 end)`,
    })
    .from(likes)
    .where(inArray(likes.postId, unique))
    .groupBy(likes.postId)
    .all();
  const values = new Map(rows.map((row) => [row.postId, { likes: Number(row.count), user_liked: Number(row.userLiked) > 0 }]));
  return Object.fromEntries(unique.map((postId) => [postId, values.get(postId) ?? { likes: 0, user_liked: false }]));
}

export function toggleLike(backendDb: BackendDb, postId: string, clientHash: string): { likes: number; user_liked: boolean } {
  backendDb.db.transaction((tx) => {
    const exists = tx
      .select({ postId: likes.postId })
      .from(likes)
      .where(and(eq(likes.postId, postId), eq(likes.ipHash, clientHash)))
      .get();
    if (exists)
      tx.delete(likes)
        .where(and(eq(likes.postId, postId), eq(likes.ipHash, clientHash)))
        .run();
    else tx.insert(likes).values({ postId, ipHash: clientHash }).run();
  });
  return likesInfo(backendDb, postId, clientHash);
}

export function clientIpHash(request: Request, config: BackendConfig): string {
  // A proxy must opt in by configuring the exact header it overwrites. Client
  // supplied x-forwarded-for is deliberately never used as an identity.
  const address = config.TRUSTED_CLIENT_IP_HEADER ? request.headers.get(config.TRUSTED_CLIENT_IP_HEADER)?.trim() || "unknown" : "anonymous";
  return crypto
    .createHmac("sha256", config.LIKES_SALT || "alexgetman-likes")
    .update(address)
    .digest("hex");
}

export function recordPageview(backendDb: BackendDb, _config: BackendConfig, rawPath: string): string {
  const path = normalizeMetricPath(rawPath);
  const now = new Date();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now,
  );
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
    .all() as Array<{
    day: string;
    total: number;
    updated_at: string | null;
  }>;
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
