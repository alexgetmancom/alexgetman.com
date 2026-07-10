import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { nextRetryAt } from "../queue/errors.js";
import { reconcilePublication, workerId } from "../queue/publish.js";
import { recordWorkerState } from "../services/workerState.js";
import { materializeSiteMedia } from "./media.js";
import { publishContentIndex } from "./contentIndex.js";
import { pingIndexNow } from "./indexNow.js";

type SiteJob = {
  job_id: number;
  post_id: number | null;
  message_id: number;
  attempt_count: number;
};

export async function runSiteJobCycle(config: BackendConfig, backendDb: BackendDb): Promise<number> {
  recoverStaleSiteJobs(config, backendDb);
  const jobs = claimSiteJobs(config, backendDb);
  if (jobs.length === 0) {
    recordWorkerState(backendDb, "site", { claimed: 0 });
    return 0;
  }
  try {
    await renderFeedFiles(config, backendDb);
    if (config.SITE_BUILD_COMMAND) {
      await runSiteBuild(config);
      const urls = publishContentIndex(config, backendDb);
      await pingIndexNow(config, urls);
    }
    completeSiteJobs(backendDb, jobs);
    recordWorkerState(backendDb, "site", { claimed: jobs.length, published: jobs.length });
  } catch (error) {
    failSiteJobs(config, backendDb, jobs, error);
    recordWorkerState(backendDb, "site", { claimed: jobs.length, published: 0 }, error instanceof Error ? error.message : String(error));
  }
  return jobs.length;
}

export function recoverStaleSiteJobs(config: BackendConfig, backendDb: BackendDb): number {
  const cutoff = new Date(Date.now() - config.SITE_JOB_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();
  const result = backendDb.sqlite
    .prepare(
      `UPDATE site_jobs
       SET status='queued', locked_by=NULL, locked_at=NULL, next_attempt_at=?, updated_at=?, last_error=COALESCE(last_error, 'stale site lock recovered')
       WHERE status='rendering' AND locked_at IS NOT NULL AND locked_at < ?`,
    )
    .run(now, now, cutoff);
  return result.changes;
}

export async function renderFeedFiles(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Promise<void> {
  const items = await Promise.all(sourceItems(backendDb).map((item) => prepareFeedItem(config, backendDb, item, fetchImpl)));
  const views = telegramViewsByMessageId(backendDb);
  for (const item of items.filter((value): value is Record<string, unknown> => value != null)) {
    const messageId = Number(item.telegram_message_id ?? item.message_id ?? 0);
    item.views = views.get(messageId) ?? Number(item.views ?? 0);
  }
  const ordered = items.filter((value): value is Record<string, unknown> => value != null).sort((a, b) => String(b.date ?? b.created_at ?? "").localeCompare(String(a.date ?? a.created_at ?? "")));
  atomicWriteJson(config.FEED_JSON, { updated_at: new Date().toISOString(), channel: config.CHANNEL_USERNAME, items: ordered });
  atomicWriteJson(config.SITE_METRICS_JSON, {
    updated_at: new Date().toISOString(),
    total: ordered.reduce((sum, item) => sum + Number(item.views ?? 0), 0),
    posts: ordered.length,
    targets: backendDb.sqlite.prepare("SELECT target, status, COUNT(*) AS count FROM post_targets GROUP BY target, status").all(),
  });
}

function claimSiteJobs(config: BackendConfig, backendDb: BackendDb): SiteJob[] {
  const now = new Date().toISOString();
  const rows = backendDb.sqlite
    .prepare(
      `SELECT *
       FROM site_jobs
       WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at, job_id
       LIMIT ?`,
    )
    .all(now, config.SITE_JOB_CLAIM_LIMIT) as SiteJob[];
  const claimed: SiteJob[] = [];
  const update = backendDb.sqlite.prepare("UPDATE site_jobs SET status='rendering', locked_by=?, locked_at=?, updated_at=? WHERE job_id=? AND status='queued'");
  backendDb.sqlite.transaction(() => {
    for (const row of rows) {
      if (update.run(workerId("site"), now, now, row.job_id).changes === 1) claimed.push(row);
    }
    if (claimed.length > 0) {
      insertSiteEvent(backendDb, "site.build.claimed", "info", `claimed ${claimed.length} site build job(s)`, { job_ids: claimed.map((job) => job.job_id) });
    }
  })();
  return claimed;
}

function completeSiteJobs(backendDb: BackendDb, jobs: SiteJob[]): void {
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    for (const job of jobs) {
      backendDb.sqlite.prepare("UPDATE site_jobs SET status='published', locked_by=NULL, locked_at=NULL, last_error=NULL, updated_at=? WHERE job_id=?").run(now, job.job_id);
    }
    insertSiteEvent(backendDb, "site.build.published", "info", `published ${jobs.length} site build job(s)`, { job_ids: jobs.map((job) => job.job_id) });
  })();
  for (const postId of new Set(jobs.map((job) => job.post_id).filter((value): value is number => value != null))) reconcilePublication(backendDb, postId);
}

function failSiteJobs(config: BackendConfig, backendDb: BackendDb, jobs: SiteJob[], error: unknown): void {
  const now = new Date().toISOString();
  const message = String(error instanceof Error ? error.message : error);
  backendDb.sqlite.transaction(() => {
    for (const job of jobs) {
      const attempt = Number(job.attempt_count ?? 0) + 1;
      const retry = attempt < config.SITE_JOB_MAX_ATTEMPTS;
      backendDb.sqlite
        .prepare("UPDATE site_jobs SET status=?, attempt_count=?, next_attempt_at=?, locked_by=NULL, locked_at=NULL, last_error=?, updated_at=? WHERE job_id=?")
        .run(retry ? "queued" : "failed", attempt, retry ? nextRetryAt(attempt, config.SITE_JOB_BACKOFF_BASE_SECONDS, config.SITE_JOB_BACKOFF_MAX_SECONDS) : null, message, now, job.job_id);
    }
    insertSiteEvent(backendDb, "site.build.failed", "error", message, { job_ids: jobs.map((job) => job.job_id) });
  })();
  for (const postId of new Set(jobs.filter((job) => Number(job.attempt_count ?? 0) + 1 >= config.SITE_JOB_MAX_ATTEMPTS).map((job) => job.post_id).filter((value): value is number => value != null))) reconcilePublication(backendDb, postId);
}

function sourceItems(backendDb: BackendDb): Record<string, unknown>[] {
  const rows = backendDb.sqlite.prepare("SELECT s.item_json, p.telegram_message_id FROM publication_sources s JOIN publications p ON p.post_id=s.post_id ORDER BY s.post_id DESC").all() as { item_json: string; telegram_message_id: number | null }[];
  if (rows.length > 0) return rows.flatMap((row): Record<string, unknown>[] => {
    const item = parseObject(row.item_json);
    return item ? [{ ...item, telegram_message_id: row.telegram_message_id ?? item.telegram_message_id }] : [];
  });
  return (backendDb.sqlite.prepare("SELECT raw_json, post_key, message_id, date_utc, text, text_en, media_json FROM posts ORDER BY created_at DESC").all() as Record<string, unknown>[]).map((row) => ({
    id: row.post_key,
    message_id: row.message_id,
    date: row.date_utc,
    text: row.text,
    text_en: row.text_en,
    media: parseObject(row.media_json),
    ...(parseObject(row.raw_json) ?? {}),
  }));
}

async function prepareFeedItem(config: BackendConfig, backendDb: BackendDb, source: Record<string, unknown>, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  const postId = Number(source.post_id ?? 0);
  if (!postId) return null;
  const now = Date.now();
  const targets = source.targets && typeof source.targets === "object" ? source.targets as Record<string, unknown> : {};
  const hasRu = Boolean(source.has_ru ?? targets.site_ru) && isDue(source.publish_at_ru, now);
  const hasEn = Boolean(source.has_en ?? targets.site_en) && isDue(source.publish_at_en, now);
  if (!hasRu && !hasEn) return null;
  const mediaRu = hasRu ? await materializeSiteMedia(config, postId, "ru", source.media ?? source.media_ru, fetchImpl) : [];
  const mediaEnSource = source.media_en ?? source.media ?? source.media_ru;
  const mediaEn = hasEn ? await materializeSiteMedia(config, postId, "en", mediaEnSource, fetchImpl) : [];
  const post = backendDb.sqlite.prepare("SELECT message_id, telegram_url FROM posts WHERE post_key=?").get(`post:${postId}`) as { message_id?: number; telegram_url?: string | null } | undefined;
  return {
    ...source,
    id: `post:${postId}`,
    post_id: postId,
    message_id: post?.message_id ?? source.message_id,
    telegram_message_id: post?.message_id ?? source.telegram_message_id,
    url: post?.telegram_url ?? source.url,
    date: source.date ?? source.publish_at_ru ?? source.publish_at_en ?? new Date().toISOString(),
    text: source.text_ru ?? source.text ?? "",
    text_ru: source.text_ru ?? source.text ?? "",
    text_en: source.text_en ?? "",
    has_ru: hasRu,
    has_en: hasEn,
    media: mediaRu,
    media_en: mediaEn,
    image: mediaRu.find((item) => item.type === "image")?.path ?? null,
    image_en: mediaEn.find((item) => item.type === "image")?.path ?? null,
  };
}

function isDue(value: unknown, now: number): boolean {
  if (typeof value !== "string" || !value) return true;
  const time = new Date(value).getTime();
  return Number.isNaN(time) || time <= now;
}

function telegramViewsByMessageId(backendDb: BackendDb): Map<number, number> {
  const rows = backendDb.sqlite
    .prepare(
      `SELECT p.message_id AS message_id, m.value AS value
       FROM post_metrics m
       JOIN posts p ON p.post_key=m.post_key
       WHERE m.target='telegram' AND m.metric_name='views'`,
    )
    .all() as { message_id: number; value: number | null }[];
  return new Map(rows.map((row) => [Number(row.message_id), Number(row.value ?? 0)]));
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.chmodSync(temp, 0o664);
  fs.renameSync(temp, filePath);
}

async function runSiteBuild(config: BackendConfig): Promise<void> {
  if (!config.SITE_BUILD_COMMAND) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.SITE_BUILD_COMMAND!, { shell: true, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`site build failed: ${output.trim() || `exit ${code}`}`)));
  });
}

function insertSiteEvent(backendDb: BackendDb, eventType: string, severity: string, message: string, details: Record<string, unknown>): void {
  backendDb.sqlite
    .prepare("INSERT INTO post_events(event_type, severity, message, details_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(eventType, severity, message, JSON.stringify(details), new Date().toISOString());
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
