import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, count, desc, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { postEvents, postMetrics, posts, postTargets, publicationSources, publications, siteJobs } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { nextRetryAt } from "../publishing/errors.js";
import { reconcilePublication, workerId } from "../publishing/queue.js";
import { publishContentIndex } from "./site-content-index.js";
import { pingIndexNow } from "./site-index-now.js";
import { materializeSiteMedia } from "./site-media.js";

type SiteJob = {
  job_id: number;
  post_id: number | null;
  message_id: number;
  attempt_count: number;
  lock_id: string;
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
    const completed = completeSiteJobs(backendDb, jobs);
    try {
      const urls = publishContentIndex(config, backendDb);
      // IndexNow is an external notification, not a prerequisite for serving
      // the already materialized feed through SSR.
      void pingIndexNow(config, urls).catch((error) => {
        insertSiteEvent(backendDb, "site.indexnow.failed", "warn", String(error instanceof Error ? error.message : error), { urls });
      });
    } catch (error) {
      insertSiteEvent(backendDb, "site.index.build.failed", "warn", String(error instanceof Error ? error.message : error), {});
    }
    recordWorkerState(backendDb, "site", { claimed: jobs.length, published: completed.length });
  } catch (error) {
    const failed = failSiteJobs(config, backendDb, jobs, error);
    recordWorkerState(
      backendDb,
      "site",
      { claimed: jobs.length, published: 0, failed: failed.length },
      error instanceof Error ? error.message : String(error),
    );
  }
  return jobs.length;
}

function recoverStaleSiteJobs(config: BackendConfig, backendDb: BackendDb): number {
  const cutoff = new Date(Date.now() - config.SITE_JOB_LOCK_TIMEOUT_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();
  return backendDb.db
    .update(siteJobs)
    .set({
      status: "queued",
      lockedBy: null,
      lockedAt: null,
      nextAttemptAt: now,
      updatedAt: now,
      lastError: sql`coalesce(${siteJobs.lastError}, 'stale site lock recovered')`,
    })
    .where(and(eq(siteJobs.status, "rendering"), isNotNull(siteJobs.lockedAt), lt(siteJobs.lockedAt, cutoff)))
    .returning({ jobId: siteJobs.jobId })
    .all().length;
}

export async function renderFeedFiles(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Promise<void> {
  const items = await Promise.all(sourceItems(backendDb).map((item) => prepareFeedItem(config, backendDb, item, fetchImpl)));
  const views = telegramViewsByMessageId(backendDb);
  for (const item of items.filter((value): value is Record<string, unknown> => value != null)) {
    const messageId = Number(item.telegram_message_id ?? item.message_id ?? 0);
    item.views = views.get(messageId) ?? Number(item.views ?? 0);
  }
  const ordered = items
    .filter((value): value is Record<string, unknown> => value != null)
    .sort((a, b) => String(b.date ?? b.created_at ?? "").localeCompare(String(a.date ?? a.created_at ?? "")));
  await atomicWriteJson(config.FEED_JSON, { updated_at: new Date().toISOString(), channel: config.CHANNEL_USERNAME, items: ordered });
  const targetCounts = backendDb.db
    .select({ target: postTargets.target, status: postTargets.status, count: count() })
    .from(postTargets)
    .groupBy(postTargets.target, postTargets.status)
    .all();
  await atomicWriteJson(config.SITE_CONTENT_METRICS_JSON, {
    updated_at: new Date().toISOString(),
    total: ordered.reduce((sum, item) => sum + Number(item.views ?? 0), 0),
    posts: ordered.length,
    targets: targetCounts,
  });
}

function claimSiteJobs(config: BackendConfig, backendDb: BackendDb): SiteJob[] {
  const now = new Date().toISOString();
  const lockId = `${workerId("site")}:${crypto.randomUUID()}`;
  const rows = backendDb.db
    .select()
    .from(siteJobs)
    .where(and(eq(siteJobs.status, "queued"), or(isNull(siteJobs.nextAttemptAt), lte(siteJobs.nextAttemptAt, now))))
    .orderBy(asc(siteJobs.createdAt), asc(siteJobs.jobId))
    .limit(config.SITE_JOB_CLAIM_LIMIT)
    .all();
  const claimed: SiteJob[] = [];
  backendDb.db.transaction((tx) => {
    for (const row of rows) {
      const claimedRow = tx
        .update(siteJobs)
        .set({ status: "rendering", lockedBy: lockId, lockedAt: now, updatedAt: now })
        .where(and(eq(siteJobs.jobId, row.jobId), eq(siteJobs.status, "queued")))
        .returning({ jobId: siteJobs.jobId })
        .get();
      if (claimedRow) {
        claimed.push({
          job_id: row.jobId,
          post_id: row.postId,
          message_id: row.messageId,
          attempt_count: row.attemptCount,
          lock_id: lockId,
        });
      }
    }
    if (claimed.length > 0) {
      insertSiteEvent(backendDb, "site.build.claimed", "info", `claimed ${claimed.length} site build job(s)`, {
        job_ids: claimed.map((job) => job.job_id),
      });
    }
  });
  return claimed;
}

function completeSiteJobs(backendDb: BackendDb, jobs: SiteJob[]): SiteJob[] {
  const now = new Date().toISOString();
  const completed: SiteJob[] = [];
  backendDb.db.transaction((tx) => {
    for (const job of jobs) {
      const updated = tx
        .update(siteJobs)
        .set({ status: "published", lockedBy: null, lockedAt: null, lastError: null, updatedAt: now })
        .where(and(eq(siteJobs.jobId, job.job_id), eq(siteJobs.status, "rendering"), eq(siteJobs.lockedBy, job.lock_id)))
        .returning({ jobId: siteJobs.jobId })
        .get();
      if (updated) completed.push(job);
    }
    if (completed.length > 0)
      insertSiteEvent(backendDb, "site.build.published", "info", `published ${completed.length} site build job(s)`, {
        job_ids: completed.map((job) => job.job_id),
      });
  });
  for (const postId of new Set(completed.map((job) => job.post_id).filter((value): value is number => value != null)))
    reconcilePublication(backendDb, postId);
  return completed;
}

function failSiteJobs(config: BackendConfig, backendDb: BackendDb, jobs: SiteJob[], error: unknown): SiteJob[] {
  const now = new Date().toISOString();
  const message = String(error instanceof Error ? error.message : error);
  const failed: SiteJob[] = [];
  backendDb.db.transaction((tx) => {
    for (const job of jobs) {
      const attempt = Number(job.attempt_count ?? 0) + 1;
      const retry = attempt < config.SITE_JOB_MAX_ATTEMPTS;
      const updated = tx
        .update(siteJobs)
        .set({
          status: retry ? "queued" : "failed",
          attemptCount: attempt,
          nextAttemptAt: retry ? nextRetryAt(attempt, config.SITE_JOB_BACKOFF_BASE_SECONDS, config.SITE_JOB_BACKOFF_MAX_SECONDS) : null,
          lockedBy: null,
          lockedAt: null,
          lastError: message,
          updatedAt: now,
        })
        .where(and(eq(siteJobs.jobId, job.job_id), eq(siteJobs.status, "rendering"), eq(siteJobs.lockedBy, job.lock_id)))
        .returning({ jobId: siteJobs.jobId })
        .get();
      if (updated) failed.push(job);
    }
    if (failed.length > 0) insertSiteEvent(backendDb, "site.build.failed", "error", message, { job_ids: failed.map((job) => job.job_id) });
  });
  for (const postId of new Set(
    failed
      .filter((job) => Number(job.attempt_count ?? 0) + 1 >= config.SITE_JOB_MAX_ATTEMPTS)
      .map((job) => job.post_id)
      .filter((value): value is number => value != null),
  ))
    reconcilePublication(backendDb, postId);
  return failed;
}

function sourceItems(backendDb: BackendDb): Record<string, unknown>[] {
  const rows = backendDb.db
    .select({ itemJson: publicationSources.itemJson, telegramMessageId: publications.telegramMessageId })
    .from(publicationSources)
    .innerJoin(publications, eq(publications.postId, publicationSources.postId))
    .orderBy(desc(publicationSources.postId))
    .all();
  if (rows.length > 0)
    return rows.flatMap((row): Record<string, unknown>[] => {
      const item = parseObject(row.itemJson);
      return item ? [{ ...item, telegram_message_id: row.telegramMessageId ?? item.telegram_message_id }] : [];
    });
  return backendDb.db
    .select({
      rawJson: posts.rawJson,
      postKey: posts.postKey,
      messageId: posts.messageId,
      dateUtc: posts.dateUtc,
      text: posts.text,
      textEn: posts.textEn,
      mediaJson: posts.mediaJson,
    })
    .from(posts)
    .orderBy(desc(posts.createdAt))
    .all()
    .map((row) => ({
      id: row.postKey,
      message_id: row.messageId,
      date: row.dateUtc,
      text: row.text,
      text_en: row.textEn,
      media: parseObject(row.mediaJson),
      ...(parseObject(row.rawJson) ?? {}),
    }));
}

async function prepareFeedItem(
  config: BackendConfig,
  backendDb: BackendDb,
  source: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  const postId = Number(source.post_id ?? 0);
  if (!postId) return null;
  const now = Date.now();
  const targets = source.targets && typeof source.targets === "object" ? (source.targets as Record<string, unknown>) : {};
  const hasRu = Boolean(source.has_ru ?? targets.site_ru) && isDue(source.publish_at_ru, now);
  const hasEn = Boolean(source.has_en ?? targets.site_en) && isDue(source.publish_at_en, now);
  if (!hasRu && !hasEn) return null;
  const mediaRu = hasRu ? await materializeSiteMedia(config, postId, "ru", source.media ?? source.media_ru, fetchImpl) : [];
  const mediaEnSource = source.media_en ?? source.media ?? source.media_ru;
  const mediaEn = hasEn ? await materializeSiteMedia(config, postId, "en", mediaEnSource, fetchImpl) : [];
  const post = backendDb.db
    .select({ messageId: posts.messageId, telegramUrl: posts.telegramUrl })
    .from(posts)
    .where(eq(posts.postKey, `post:${postId}`))
    .get();
  return {
    ...source,
    id: `post:${postId}`,
    post_id: postId,
    message_id: post?.messageId ?? source.message_id,
    telegram_message_id: post?.messageId ?? source.telegram_message_id,
    url: post?.telegramUrl ?? source.url,
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
  const rows = backendDb.db
    .select({ messageId: posts.messageId, value: postMetrics.value })
    .from(postMetrics)
    .innerJoin(posts, eq(posts.postKey, postMetrics.postKey))
    .where(and(eq(postMetrics.target, "telegram"), eq(postMetrics.metricName, "views")))
    .all();
  return new Map(rows.map((row) => [Number(row.messageId), Number(row.value ?? 0)]));
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await Bun.write(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.chmodSync(temp, 0o664);
  fs.renameSync(temp, filePath);
}

function insertSiteEvent(
  backendDb: BackendDb,
  eventType: string,
  severity: string,
  message: string,
  details: Record<string, unknown>,
): void {
  backendDb.db
    .insert(postEvents)
    .values({ eventType, severity, message, detailsJson: JSON.stringify(details), createdAt: new Date().toISOString() })
    .run();
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
