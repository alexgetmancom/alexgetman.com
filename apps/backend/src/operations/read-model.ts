import fs from "node:fs";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import {
  type JsonValue,
  metricSamples,
  metricSchedule,
  postLocales,
  postMetrics,
  posts,
  postTargets,
  publications,
  publishJobs,
  siteJobs,
  workerState,
} from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { gitRevision } from "../foundation/runtime/git.js";
import { formatZonedSortable, zonedRollingPeriodBounds } from "../foundation/time.js";
import { jsonArray } from "../json.js";

export type PipelineReadModelOptions = {
  /** Dashboard charts are the only consumers that need immutable samples. */
  includeSamples?: boolean;
  /** Hard cap per (post, target, metric) series after time bucketing. */
  sampleLimitPerSeries?: number;
};

type ResolvedPipelineReadModelOptions = {
  includeSamples: boolean;
  sampleLimitPerSeries: number;
};

type PipelineTargetRow = Pick<
  typeof postTargets.$inferSelect,
  "postKey" | "target" | "status" | "externalId" | "externalIdsJson" | "url" | "error" | "skipped" | "updatedAt"
>;

type PipelineMetricRow = Pick<
  typeof postMetrics.$inferSelect,
  "postKey" | "target" | "metricName" | "value" | "source" | "sampledAt" | "error"
>;

type PipelineSampleRow = {
  id: number;
  postKey: string;
  target: string;
  metricName: string;
  value: number | null;
  sampledAt: string;
  bucket: number;
};

const MAX_SAMPLE_LIMIT_PER_SERIES = 200;

/** Operations read model over publication, delivery and worker state. */
export function pipelineStatusPayload(
  config: BackendConfig,
  backendDb: BackendDb,
  weekOffset = 0,
  periodDays = 7,
  comparisonOffset = 0,
  offsetDays?: number,
  options: PipelineReadModelOptions = {},
) {
  const readModelOptions = resolvePipelineReadModelOptions(options);
  const jobs = backendDb.db
    .select({
      jobId: publishJobs.jobId,
      postId: publishJobs.postId,
      postKey: publishJobs.postKey,
      messageId: publishJobs.messageId,
      target: publishJobs.target,
      status: publishJobs.status,
      attemptCount: publishJobs.attemptCount,
      publishAt: publishJobs.publishAt,
      nextAttemptAt: publishJobs.nextAttemptAt,
      lastError: publishJobs.lastError,
      createdAt: publishJobs.createdAt,
      updatedAt: publishJobs.updatedAt,
    })
    .from(publishJobs)
    .orderBy(desc(publishJobs.updatedAt))
    .limit(50)
    .all();

  const workers = backendDb.db
    .select({ name: workerState.name, stateJson: workerState.stateJson, updatedAt: workerState.updatedAt })
    .from(workerState)
    .all()
    .map((row) => {
      const state: Record<string, JsonValue> = row.stateJson;
      return {
        name: row.name,
        ok: state.ok !== false,
        lastRunAt: typeof state.last_run_at === "string" ? state.last_run_at : row.updatedAt,
        nextRunAt: typeof state.next_run_at === "string" ? state.next_run_at : null,
        lastError: typeof state.last_error === "string" ? state.last_error : null,
      };
    });

  const [postCount] = backendDb.db.select({ count: sql<number>`count(*)` }).from(posts).all();
  const [targetCount] = backendDb.db.select({ count: sql<number>`count(*)` }).from(postTargets).all();
  const [metricCount] = backendDb.db.select({ count: sql<number>`count(*)` }).from(postMetrics).all();
  const [sampleCount] = backendDb.db.select({ count: sql<number>`count(*)` }).from(metricSamples).all();
  const latestSiteJobs = backendDb.db
    .select({
      jobId: siteJobs.jobId,
      postId: siteJobs.postId,
      messageId: siteJobs.messageId,
      reason: siteJobs.reason,
      status: siteJobs.status,
      attemptCount: siteJobs.attemptCount,
      nextAttemptAt: siteJobs.nextAttemptAt,
      lastError: siteJobs.lastError,
      createdAt: siteJobs.createdAt,
      updatedAt: siteJobs.updatedAt,
    })
    .from(siteJobs)
    .orderBy(desc(siteJobs.updatedAt), desc(siteJobs.jobId))
    .limit(25)
    .all();
  const recentMetrics = backendDb.db
    .select({
      postKey: postMetrics.postKey,
      target: postMetrics.target,
      metricName: postMetrics.metricName,
      value: postMetrics.value,
      source: postMetrics.source,
      sampledAt: postMetrics.sampledAt,
      error: postMetrics.error,
      messageId: posts.messageId,
      postUrl: sql<string | null>`coalesce(${posts.siteEnPath}, ${posts.siteRuPath}, ${posts.telegramUrl})`,
    })
    .from(postMetrics)
    .leftJoin(posts, eq(posts.postKey, postMetrics.postKey))
    .orderBy(desc(postMetrics.sampledAt), asc(postMetrics.postKey), asc(postMetrics.target), asc(postMetrics.metricName))
    .limit(100)
    .all();
  const now = new Date().toISOString();
  const [metricScheduleSummary] = backendDb.db
    .select({
      total: sql<number>`count(*)`,
      frozen: sql<number>`sum(case when ${metricSchedule.frozenAt} is not null then 1 else 0 end)`,
      due: sql<number>`sum(case when ${metricSchedule.frozenAt} is null and (${metricSchedule.nextCheckAt} is null or ${metricSchedule.nextCheckAt} <= ${now}) then 1 else 0 end)`,
      errors: sql<number>`sum(case when ${metricSchedule.frozenAt} is null and ${metricSchedule.lastError} is not null then 1 else 0 end)`,
      lastCheckedAt: sql<string | null>`max(${metricSchedule.lastCheckedAt})`,
    })
    .from(metricSchedule)
    .all();
  const pipelinePostRows = pipelinePosts(backendDb, config, weekOffset, periodDays, comparisonOffset, offsetDays, readModelOptions);
  const feed = readFeedSummary(config, backendDb);
  const socialState = readWorkerState(backendDb, "crosspost_worker") ?? readWorkerState(backendDb, "queue") ?? {};
  const [targetFailureCount] = backendDb.db
    .select({ count: sql<number>`count(*)` })
    .from(postTargets)
    .where(eq(postTargets.status, "failed"))
    .all();
  const [siteFailureCount] = backendDb.db
    .select({ count: sql<number>`count(*)` })
    .from(siteJobs)
    .where(eq(siteJobs.status, "failed"))
    .all();

  const generatedAt = new Date().toISOString();
  const stableUpdatedAt = pipelineUpdatedAt(backendDb);
  return {
    ok: Number(targetFailureCount?.count ?? 0) === 0 && Number(siteFailureCount?.count ?? 0) === 0 && workers.every((worker) => worker.ok),
    generatedAt,
    gitRevision: gitRevision(),
    pipelineDb: {
      path: config.PIPELINE_DB,
      exists: fs.existsSync(config.PIPELINE_DB),
    },
    jobs,
    siteJobs: latestSiteJobs,
    workers,
    metrics: {
      generatedAt,
      posts: Number(postCount?.count ?? 0),
      targets: Number(targetCount?.count ?? 0),
      metrics: Number(metricCount?.count ?? 0),
      samples: Number(sampleCount?.count ?? 0),
      schedule: metricScheduleSummary,
      recent: recentMetrics,
    },
    updated_at: stableUpdatedAt ?? generatedAt,
    feed,
    social_worker: {
      pipeline_db: config.PIPELINE_DB,
      last_update_id: socialState.last_update_id ?? null,
      processed_count: Array.isArray(socialState.processed_message_ids)
        ? socialState.processed_message_ids.length
        : Number(socialState.claimed ?? 0),
    },
    posts: pipelinePostRows,
  };
}

function pipelinePosts(
  backendDb: BackendDb,
  config: BackendConfig,
  weekOffset: number,
  periodDays: number,
  comparisonOffset: number,
  offsetDays?: number,
  options: ResolvedPipelineReadModelOptions = resolvePipelineReadModelOptions({}),
): Record<string, unknown>[] {
  const periodOffsetDays = offsetDays ?? (weekOffset + comparisonOffset) * periodDays;
  const [start, end] = zonedRollingPeriodBounds(periodOffsetDays / periodDays, periodDays, config.TIMEZONE);
  const rows = fetchPostRows(backendDb, start, end);
  const postKeys = rows.map((row) => String(row.post_key ?? "")).filter(Boolean);
  const targetRows = postKeys.length
    ? backendDb.db
        .select({
          postKey: postTargets.postKey,
          target: postTargets.target,
          status: postTargets.status,
          externalId: postTargets.externalId,
          externalIdsJson: postTargets.externalIdsJson,
          url: postTargets.url,
          error: postTargets.error,
          skipped: postTargets.skipped,
          updatedAt: postTargets.updatedAt,
        })
        .from(postTargets)
        .where(inArray(postTargets.postKey, postKeys))
        .orderBy(asc(postTargets.target))
        .all()
    : [];
  const metricRows = postKeys.length
    ? backendDb.db
        .select({
          postKey: postMetrics.postKey,
          target: postMetrics.target,
          metricName: postMetrics.metricName,
          value: postMetrics.value,
          source: postMetrics.source,
          sampledAt: postMetrics.sampledAt,
          error: postMetrics.error,
        })
        .from(postMetrics)
        .where(inArray(postMetrics.postKey, postKeys))
        .orderBy(asc(postMetrics.target), asc(postMetrics.metricName))
        .all()
    : [];
  const sampleRows = options.includeSamples
    ? fetchMetricSamples(backendDb, postKeys, start, end, periodDays, options.sampleLimitPerSeries)
    : [];
  return formatPipelinePosts(config, rows, targetRows, metricRows, sampleRows);
}

function fetchPostRows(backendDb: BackendDb, start: string, end: string) {
  const ru = alias(postLocales, "pipeline_ru");
  const en = alias(postLocales, "pipeline_en");
  const publicationRows = backendDb.db
    .select({
      postId: publications.postId,
      telegramMessageId: publications.telegramMessageId,
      createdAt: publications.createdAt,
      updatedAt: publications.updatedAt,
      textRu: ru.text,
      mediaRuJson: ru.mediaJson,
      siteRu: ru.siteEnabled,
      slugRu: ru.slug,
      textEn: en.text,
      mediaEnJson: en.mediaJson,
      siteEn: en.siteEnabled,
      slugEn: en.slug,
    })
    .from(publications)
    .leftJoin(ru, and(eq(ru.postId, publications.postId), eq(ru.locale, "ru")))
    .leftJoin(en, and(eq(en.postId, publications.postId), eq(en.locale, "en")))
    .where(and(gte(publications.createdAt, start), lte(publications.createdAt, end)))
    .orderBy(desc(publications.createdAt))
    .limit(100)
    .all();
  const publicationKeys = publicationRows.map((row) => `post:${row.postId}`);
  const publicationPosts = publicationKeys.length
    ? backendDb.db
        .select({ postKey: posts.postKey, messageId: posts.messageId, dateMsk: posts.dateMsk, telegramUrl: posts.telegramUrl })
        .from(posts)
        .where(inArray(posts.postKey, publicationKeys))
        .all()
    : [];
  const postByKey = new Map(publicationPosts.map((post) => [post.postKey, post]));
  return publicationRows.map((row) => {
    const post = postByKey.get(`post:${row.postId}`);
    return {
      post_key: `post:${row.postId}`,
      post_id: row.postId,
      telegram_message_id: row.telegramMessageId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      text_ru: row.textRu,
      media_ru_json: row.mediaRuJson,
      site_ru: row.siteRu,
      slug_ru: row.slugRu,
      text_en: row.textEn,
      media_en_json: row.mediaEnJson,
      site_en: row.siteEn,
      slug_en: row.slugEn,
      message_id: post?.messageId ?? row.telegramMessageId,
      date_msk: post?.dateMsk,
      telegram_url: post?.telegramUrl,
    };
  });
}

function formatPipelinePosts(
  config: BackendConfig,
  rows: ReturnType<typeof fetchPostRows>,
  targetRows: PipelineTargetRow[],
  metricRows: PipelineMetricRow[],
  sampleRows: PipelineSampleRow[],
): Record<string, unknown>[] {
  const targetsByPost = groupBy(targetRows, (target) => target.postKey);
  const metricsByPost = groupBy(metricRows, (metric) => metric.postKey);
  const samplesByMetric = groupBy(sampleRows, (sample) => `${sample.postKey}\u0000${sample.target}\u0000${sample.metricName}`);
  return rows.map((row) => {
    const postId = row.post_id == null ? null : Number(row.post_id);
    const postKey = String(row.post_key ?? `post:${postId}`);
    const targets = Object.fromEntries(
      (targetsByPost.get(postKey) ?? []).map((target) => [
        target.target,
        {
          status: target.status,
          ok: target.status === "published",
          external_id: target.externalId,
          external_ids: target.externalIdsJson ?? [],
          url: target.url,
          error: target.error,
          skipped: Boolean(target.skipped),
          updated_at: target.updatedAt,
        },
      ]),
    );
    const metrics: Record<string, Record<string, unknown>> = {};
    for (const metric of metricsByPost.get(postKey) ?? []) {
      const target = metric.target;
      const targetMetrics = metrics[target] ?? {};
      metrics[target] = targetMetrics;
      targetMetrics[metric.metricName] = {
        value: metric.value,
        sampled_at: metric.sampledAt,
        source: metric.source,
        error: metric.error,
        samples: (samplesByMetric.get(`${postKey}\u0000${target}\u0000${metric.metricName}`) ?? []).map((sample) => ({
          value: sample.value,
          sampled_at: sample.sampledAt,
        })),
      };
    }
    const mediaRu = jsonArray(row.media_ru_json);
    const mediaEn = jsonArray(row.media_en_json);
    const textRu = String(row.text_ru ?? "");
    const textEn = String(row.text_en ?? "");
    const telegramMessageId = row.telegram_message_id == null ? null : Number(row.telegram_message_id);
    const telegramUrl =
      typeof row.telegram_url === "string" && row.telegram_url
        ? row.telegram_url
        : telegramMessageId
          ? `https://t.me/${config.CHANNEL_USERNAME.replace(/^@/, "")}/${telegramMessageId}`
          : null;
    const localesMap = { ru: { site_enabled: Number(row.site_ru ?? 0) }, en: { site_enabled: Number(row.site_en ?? 0) } };
    const result: Record<string, unknown> = {
      post_id: postId,
      // The channel message id resolved in fetchPostRows, not the post id: the
      // two are unrelated and a dashboard lookup by message_id needs the real one.
      message_id: row.message_id == null ? telegramMessageId : Number(row.message_id),
      telegram_message_id: telegramMessageId,
      date: row.created_at,
      date_msk: row.date_msk ?? formatZonedSortable(String(row.created_at), config.TIMEZONE),
      text_ru: shortText(textRu),
      text_en: shortText(textEn),
      full_text_ru: textRu,
      full_text_en: textEn,
      text: shortText(textRu),
      // Dashboard rendering needs the raw arrays, not just their summary.
      media_ru_json: row.media_ru_json,
      media_en_json: row.media_en_json,
      media_count: (mediaEn.length ? mediaEn : mediaRu).length,
      media_types: [
        ...new Set(
          (mediaEn.length ? mediaEn : mediaRu)
            .map((item) => (item && typeof item === "object" ? String((item as Record<string, unknown>).type ?? "") : ""))
            .filter(Boolean),
        ),
      ],
      slug_en: row.slug_en,
      slug_ru: row.slug_ru,
      // Locale-agnostic "the post's page" for payload consumers. Per-target links
      // must not use it — it falls back across locales — see dashboard/target-url.ts.
      site_url: Number(row.site_ru) ? `/ru/${postId}/${row.slug_ru}/` : Number(row.site_en) ? `/${postId}/${row.slug_en}/` : null,
      telegram_url: telegramUrl,
      targets,
      metrics,
      locales_map: localesMap,
    };
    for (const [target] of TARGETS) {
      const record = targets[target] as { status?: unknown } | undefined;
      result[target] =
        record?.status === "published" ||
        (target === "telegram" && Boolean(telegramUrl)) ||
        (target === "site_ru" && Boolean(row.site_ru)) ||
        (target === "site_en" && Boolean(row.site_en));
    }
    return result;
  });
}

function resolvePipelineReadModelOptions(options: PipelineReadModelOptions): ResolvedPipelineReadModelOptions {
  return {
    includeSamples: options.includeSamples === true,
    sampleLimitPerSeries: Math.max(
      1,
      Math.min(MAX_SAMPLE_LIMIT_PER_SERIES, Math.floor(options.sampleLimitPerSeries ?? MAX_SAMPLE_LIMIT_PER_SERIES)),
    ),
  };
}

function fetchMetricSamples(
  backendDb: BackendDb,
  postKeys: string[],
  start: string,
  end: string,
  periodDays: number,
  limitPerSeries: number,
): PipelineSampleRow[] {
  if (postKeys.length === 0) return [];
  const placeholders = postKeys.map(() => "?").join(",");
  const bucketSeconds = periodDays <= 7 ? 60 * 60 : 24 * 60 * 60;
  const rows = backendDb.sqlite
    .prepare(
      `WITH bucketed AS (
         SELECT id, post_key, target, metric_name, value, sampled_at,
                CAST((unixepoch(sampled_at) - unixepoch(?)) / ? AS INTEGER) AS bucket
           FROM metric_samples
          WHERE post_key IN (${placeholders}) AND sampled_at >= ? AND sampled_at <= ?
       ),
       bucketedRanks AS (
         SELECT id, post_key, target, metric_name, value, sampled_at, bucket,
                ROW_NUMBER() OVER (
                  PARTITION BY post_key, target, metric_name, bucket
                  ORDER BY sampled_at DESC, id DESC
                ) AS bucketRank
           FROM bucketed
       ),
       latestBuckets AS (
         SELECT id, post_key, target, metric_name, value, sampled_at, bucket
           FROM bucketedRanks
          WHERE bucketRank = 1
       ),
       seriesRanks AS (
         SELECT id, post_key, target, metric_name, value, sampled_at, bucket,
                ROW_NUMBER() OVER (
                  PARTITION BY post_key, target, metric_name
                  ORDER BY bucket ASC
                ) AS seriesRank
           FROM latestBuckets
       )
       SELECT id, post_key AS postKey, target, metric_name AS metricName, value, sampled_at AS sampledAt, bucket
         FROM seriesRanks
        WHERE seriesRank <= ?
        ORDER BY postKey ASC, target ASC, metricName ASC, bucket ASC`,
    )
    .all(start, bucketSeconds, ...postKeys, start, end, limitPerSeries) as PipelineSampleRow[];
  const startMs = Math.floor(Date.parse(start) / 1_000) * 1_000;
  return rows.map((row) => ({ ...row, sampledAt: new Date(startMs + row.bucket * bucketSeconds * 1000).toISOString() }));
}

/** Stable revision for the pipeline read model. It must not be request time. */
export function pipelineUpdatedAt(backendDb: BackendDb): string | null {
  const row = backendDb.sqlite
    .prepare(
      `SELECT MAX(value) AS value
         FROM (
           SELECT MAX(updated_at) AS value FROM posts
           UNION ALL SELECT MAX(updated_at) FROM post_targets
           UNION ALL SELECT MAX(sampled_at) FROM post_metrics
           UNION ALL SELECT MAX(sampled_at) FROM metric_samples
           UNION ALL SELECT MAX(updated_at) FROM publish_jobs
           UNION ALL SELECT MAX(updated_at) FROM site_jobs
           UNION ALL SELECT MAX(updated_at) FROM metric_schedule
         )`,
    )
    .get() as { value: string | null };
  return row.value ?? null;
}

function readFeedSummary(config: BackendConfig, backendDb: BackendDb): { channel: string; updated_at: string | null; items: number } {
  const [summary] = backendDb.db
    .select({ items: sql<number>`count(*)`, updatedAt: sql<string | null>`max(${posts.updatedAt})` })
    .from(posts)
    .all();
  return { channel: config.CHANNEL_USERNAME, updated_at: summary?.updatedAt ?? null, items: Number(summary?.items ?? 0) };
}

function readWorkerState(backendDb: BackendDb, name: string): Record<string, unknown> | null {
  const row = backendDb.db.select({ stateJson: workerState.stateJson }).from(workerState).where(eq(workerState.name, name)).get();
  return row?.stateJson ?? null;
}

function shortText(value: string): string {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.length <= 7 ? words.join(" ") : `${words.slice(0, 7).join(" ")}...`;
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const values = grouped.get(groupKey) ?? [];
    values.push(row);
    grouped.set(groupKey, values);
  }
  return grouped;
}
