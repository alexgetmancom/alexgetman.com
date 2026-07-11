import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, or, sql } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { likes, metricSamples, postMetrics, posts } from "../db/schema.js";

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
  return Object.fromEntries(postIds.map((postId) => [postId, likesInfo(backendDb, postId, clientHash)]));
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
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown";
  return crypto
    .createHmac("sha256", config.LIKES_SALT || config.commandCenterToken || "alexgetman-likes")
    .update(address)
    .digest("hex");
}

export function recordPageview(backendDb: BackendDb, config: BackendConfig, rawPath: string): string {
  const path = normalizeMetricPath(rawPath);
  const now = new Date();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now,
  );
  const data = readMetricsFile(config);
  data.total = Number(data.total ?? 0) + 1;
  const days = data.days as Record<string, { total: number; paths: Record<string, number> }>;
  let bucket = days[day];
  if (!bucket) {
    bucket = { total: 0, paths: {} };
    days[day] = bucket;
  }
  bucket.total += 1;
  bucket.paths[path] = Number(bucket.paths[path] ?? 0) + 1;
  data.updated_at = now.toISOString();
  atomicWrite(config.SITE_METRICS_JSON, data);

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
  if (row) {
    const existing = backendDb.db
      .select({ value: postMetrics.value })
      .from(postMetrics)
      .where(and(eq(postMetrics.postKey, row.postKey), eq(postMetrics.target, row.target), eq(postMetrics.metricName, "views")))
      .get();
    const value = Number(existing?.value ?? 0) + 1;
    const sampledAt = now.toISOString();
    backendDb.db
      .insert(postMetrics)
      .values({
        postKey: row.postKey,
        target: row.target,
        metricName: "views",
        value,
        source: "site_pageview_endpoint",
        sampledAt,
        error: null,
        rawJson: { path },
      })
      .onConflictDoUpdate({
        target: [postMetrics.postKey, postMetrics.target, postMetrics.metricName],
        set: { value, source: "site_pageview_endpoint", sampledAt, error: null, rawJson: { path } },
      })
      .run();
    backendDb.db
      .insert(metricSamples)
      .values({
        postKey: row.postKey,
        target: row.target,
        metricName: "views",
        value,
        sampledAt,
        source: "site_pageview_endpoint",
        rawJson: { path },
      })
      .run();
  }
  return path;
}

export function metricsSummary(config: BackendConfig): { total: number; today: number; last7: number; updated_at: unknown } {
  const data = readMetricsFile(config);
  const days = data.days as Record<string, { total?: number }>;
  const keys = Object.keys(days).sort().reverse();
  return {
    total: Number(data.total ?? 0),
    today: Number(days[keys[0] ?? ""]?.total ?? 0),
    last7: keys.slice(0, 7).reduce((sum, key) => sum + Number(days[key]?.total ?? 0), 0),
    updated_at: data.updated_at ?? null,
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

function readMetricsFile(
  config: BackendConfig,
): Record<string, unknown> & { days: Record<string, { total: number; paths: Record<string, number> }> } {
  try {
    const data = JSON.parse(fs.readFileSync(config.SITE_METRICS_JSON, "utf8")) as Record<string, unknown>;
    return {
      ...data,
      days:
        data.days && typeof data.days === "object" ? (data.days as Record<string, { total: number; paths: Record<string, number> }>) : {},
    };
  } catch {
    return { total: 0, updated_at: null, days: {} };
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}
