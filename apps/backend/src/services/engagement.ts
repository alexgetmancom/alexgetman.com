import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";

export function likesInfo(backendDb: BackendDb, postId: string, clientHash: string): { likes: number; user_liked: boolean } {
  const count = backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM likes WHERE post_id=?").get(postId) as { count: number };
  const liked = backendDb.sqlite.prepare("SELECT 1 AS found FROM likes WHERE post_id=? AND ip_hash=?").get(postId, clientHash);
  return { likes: Number(count.count), user_liked: Boolean(liked) };
}

export function batchLikes(
  backendDb: BackendDb,
  postIds: string[],
  clientHash: string,
): Record<string, { likes: number; user_liked: boolean }> {
  return Object.fromEntries(postIds.map((postId) => [postId, likesInfo(backendDb, postId, clientHash)]));
}

export function toggleLike(backendDb: BackendDb, postId: string, clientHash: string): { likes: number; user_liked: boolean } {
  backendDb.sqlite.transaction(() => {
    const exists = backendDb.sqlite.prepare("SELECT 1 FROM likes WHERE post_id=? AND ip_hash=?").get(postId, clientHash);
    if (exists) backendDb.sqlite.prepare("DELETE FROM likes WHERE post_id=? AND ip_hash=?").run(postId, clientHash);
    else backendDb.sqlite.prepare("INSERT INTO likes(post_id, ip_hash) VALUES (?, ?)").run(postId, clientHash);
  })();
  return likesInfo(backendDb, postId, clientHash);
}

export function clientIpHash(c: Context, config: BackendConfig): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const address = forwarded || c.req.header("x-real-ip") || "unknown";
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
  const row = backendDb.sqlite
    .prepare(
      `SELECT post_key, 'site_ru' AS target FROM posts WHERE site_ru_path IN (?, ?)
     UNION ALL SELECT post_key, 'site_en' AS target FROM posts WHERE site_en_path IN (?, ?) LIMIT 1`,
    )
    .get(...candidates, ...candidates) as { post_key?: string; target?: string } | undefined;
  if (row?.post_key && row.target) {
    const existing = backendDb.sqlite
      .prepare("SELECT value FROM post_metrics WHERE post_key=? AND target=? AND metric_name='views'")
      .get(row.post_key, row.target) as { value?: number } | undefined;
    const value = Number(existing?.value ?? 0) + 1;
    const rawJson = JSON.stringify({ path });
    backendDb.sqlite
      .prepare(`INSERT INTO post_metrics(post_key,target,metric_name,value,source,sampled_at,error,raw_json)
      VALUES (?,?,'views',?,'site_pageview_endpoint',?,NULL,?)
      ON CONFLICT(post_key,target,metric_name) DO UPDATE SET value=excluded.value,source=excluded.source,sampled_at=excluded.sampled_at,error=NULL,raw_json=excluded.raw_json`)
      .run(row.post_key, row.target, value, now.toISOString(), rawJson);
    backendDb.sqlite
      .prepare(
        "INSERT INTO metric_samples(post_key,target,metric_name,value,sampled_at,source,raw_json) VALUES (?,?,'views',?,?,'site_pageview_endpoint',?)",
      )
      .run(row.post_key, row.target, value, now.toISOString(), rawJson);
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
    .split("#", 1)[0]!
    .split("?", 1)[0]!
    .trim();
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
