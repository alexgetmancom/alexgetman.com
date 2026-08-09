import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { postLocales, postMetrics, posts, postTargets, publications } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { zonedRollingPeriodBounds } from "../foundation/time.js";
import {
  formatPipelinePosts,
  type PipelineMetricRow,
  type PipelinePostRow,
  type PipelineSampleRow,
  type PipelineTargetRow,
} from "./pipeline-presenter.js";

export type PipelineReadModelOptions = {
  /** Dashboard charts are the only consumers that need immutable samples. */
  includeSamples?: boolean;
  /** Comparison read models only need dates, statuses and metrics, not copy or media. */
  includeContent?: boolean;
  /** Use narrow target/metric projections for dashboard summaries. */
  compact?: boolean;
  /** Load full locale/media content only for the newest N publications. */
  contentLimit?: number;
  /** Hard cap per (post, target, metric) series after time bucketing. */
  sampleLimitPerSeries?: number;
};

type ResolvedPipelineReadModelOptions = {
  includeSamples: boolean;
  includeContent: boolean;
  compact: boolean;
  contentLimit: number | null;
  sampleLimitPerSeries: number;
};

const MAX_SAMPLE_LIMIT_PER_SERIES = 200;

/** Compact post read model used by the overview and publication detail loaders. */
export function pipelineOverviewPayload(
  config: BackendConfig,
  backendDb: BackendDb,
  weekOffset = 0,
  periodDays = 7,
  comparisonOffset = 0,
  offsetDays?: number,
  options: PipelineReadModelOptions = {},
) {
  const readModelOptions = resolvePipelineReadModelOptions(options);
  return { posts: pipelinePosts(backendDb, config, weekOffset, periodDays, comparisonOffset, offsetDays, readModelOptions) };
}

/** One bounded history holding two adjacent dashboard periods, each capped at the public read model's 100 posts. */
export function dashboardPipelineHistoryPayload(config: BackendConfig, backendDb: BackendDb, periodDays: number, offsetDays: number) {
  const options = resolvePipelineReadModelOptions({ includeSamples: false, contentLimit: 4, compact: true });
  return { posts: pipelinePosts(backendDb, config, 0, periodDays, 0, offsetDays, options, 200) };
}

function pipelinePosts(
  backendDb: BackendDb,
  config: BackendConfig,
  weekOffset: number,
  periodDays: number,
  comparisonOffset: number,
  offsetDays?: number,
  options: ResolvedPipelineReadModelOptions = resolvePipelineReadModelOptions({}),
  rowLimit = 100,
): Record<string, unknown>[] {
  const periodOffsetDays = offsetDays ?? (weekOffset + comparisonOffset) * periodDays;
  const [start, end] = zonedRollingPeriodBounds(periodOffsetDays / periodDays, periodDays, config.TIMEZONE);
  const rows = fetchPostRows(backendDb, start, end, options.includeContent, options.contentLimit, rowLimit);
  const postKeys = rows.map((row) => String(row.post_key ?? "")).filter(Boolean);
  const targetRows = (
    postKeys.length
      ? unsafeDb(backendDb)
          .db.select(
            options.compact
              ? {
                  postKey: postTargets.postKey,
                  target: postTargets.target,
                  status: postTargets.status,
                  url: postTargets.url,
                }
              : {
                  postKey: postTargets.postKey,
                  target: postTargets.target,
                  status: postTargets.status,
                  externalId: postTargets.externalId,
                  externalIdsJson: postTargets.externalIdsJson,
                  url: postTargets.url,
                  error: postTargets.error,
                  skipped: postTargets.skipped,
                  updatedAt: postTargets.updatedAt,
                },
          )
          .from(postTargets)
          .where(inArray(postTargets.postKey, postKeys))
          .orderBy(asc(postTargets.target))
          .all()
      : []
  ) as PipelineTargetRow[];
  const metricRows = (
    postKeys.length
      ? unsafeDb(backendDb)
          .db.select(
            options.compact
              ? {
                  postKey: postMetrics.postKey,
                  target: postMetrics.target,
                  metricName: postMetrics.metricName,
                  value: postMetrics.value,
                }
              : {
                  postKey: postMetrics.postKey,
                  target: postMetrics.target,
                  metricName: postMetrics.metricName,
                  value: postMetrics.value,
                  source: postMetrics.source,
                  sampledAt: postMetrics.sampledAt,
                  error: postMetrics.error,
                },
          )
          .from(postMetrics)
          .where(inArray(postMetrics.postKey, postKeys))
          .orderBy(asc(postMetrics.target), asc(postMetrics.metricName))
          .all()
      : []
  ) as PipelineMetricRow[];
  const sampleRows = options.includeSamples
    ? fetchMetricSamples(backendDb, postKeys, start, end, periodDays, options.sampleLimitPerSeries)
    : [];
  return formatPipelinePosts(config, rows, targetRows, metricRows, sampleRows, options.includeContent, options.compact);
}

type PublicationQueryRow = {
  postId: number;
  telegramMessageId: number | null;
  createdAt: string;
  updatedAt: string;
  textRu?: string | null;
  mediaRuJson?: unknown;
  siteRu?: number | null;
  slugRu?: string | null;
  textEn?: string | null;
  mediaEnJson?: unknown;
  siteEn?: number | null;
  slugEn?: string | null;
};

function fetchPostRows(
  backendDb: BackendDb,
  start: string,
  end: string,
  includeContent: boolean,
  contentLimit: number | null = null,
  rowLimit = 100,
): PipelinePostRow[] {
  const ru = alias(postLocales, "pipeline_ru");
  const en = alias(postLocales, "pipeline_en");
  const boundedContent = includeContent && contentLimit !== null;
  const publicationRows = (
    includeContent && !boundedContent
      ? unsafeDb(backendDb)
          .db.select({
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
          .limit(rowLimit)
          .all()
      : boundedContent
        ? unsafeDb(backendDb)
            .db.select({
              postId: publications.postId,
              telegramMessageId: publications.telegramMessageId,
              createdAt: publications.createdAt,
              updatedAt: publications.updatedAt,
              siteRu: ru.siteEnabled,
              slugRu: ru.slug,
              siteEn: en.siteEnabled,
              slugEn: en.slug,
            })
            .from(publications)
            .leftJoin(ru, and(eq(ru.postId, publications.postId), eq(ru.locale, "ru")))
            .leftJoin(en, and(eq(en.postId, publications.postId), eq(en.locale, "en")))
            .where(and(gte(publications.createdAt, start), lte(publications.createdAt, end)))
            .orderBy(desc(publications.createdAt))
            .limit(rowLimit)
            .all()
        : unsafeDb(backendDb)
            .db.select({
              postId: publications.postId,
              telegramMessageId: publications.telegramMessageId,
              createdAt: publications.createdAt,
              updatedAt: publications.updatedAt,
            })
            .from(publications)
            .where(and(gte(publications.createdAt, start), lte(publications.createdAt, end)))
            .orderBy(desc(publications.createdAt))
            .limit(rowLimit)
            .all()
  ) as PublicationQueryRow[];
  if (boundedContent) {
    const contentPostIds = publicationRows
      .slice(0, Math.max(0, Math.min(rowLimit, Math.floor(contentLimit ?? 0))))
      .map((row) => row.postId);
    if (contentPostIds.length) {
      const contentRows = unsafeDb(backendDb)
        .db.select({ postId: postLocales.postId, locale: postLocales.locale, text: postLocales.text, mediaJson: postLocales.mediaJson })
        .from(postLocales)
        .where(inArray(postLocales.postId, contentPostIds))
        .all();
      const contentByPost = new Map<
        number,
        { ru?: { text: string | null; mediaJson: unknown }; en?: { text: string | null; mediaJson: unknown } }
      >();
      for (const content of contentRows) {
        const entry = contentByPost.get(content.postId) ?? {};
        if (content.locale === "ru") entry.ru = { text: content.text, mediaJson: content.mediaJson };
        if (content.locale === "en") entry.en = { text: content.text, mediaJson: content.mediaJson };
        contentByPost.set(content.postId, entry);
      }
      for (const row of publicationRows.slice(0, contentPostIds.length)) {
        const content = contentByPost.get(row.postId);
        row.textRu = content?.ru?.text ?? null;
        row.mediaRuJson = content?.ru?.mediaJson ?? null;
        row.textEn = content?.en?.text ?? null;
        row.mediaEnJson = content?.en?.mediaJson ?? null;
      }
    }
  }
  const publicationKeys = publicationRows.map((row) => `post:${row.postId}`);
  const publicationPosts = publicationKeys.length
    ? unsafeDb(backendDb)
        .db.select({ postKey: posts.postKey, messageId: posts.messageId, dateMsk: posts.dateMsk, telegramUrl: posts.telegramUrl })
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

function resolvePipelineReadModelOptions(options: PipelineReadModelOptions): ResolvedPipelineReadModelOptions {
  return {
    includeSamples: options.includeSamples === true,
    includeContent: options.includeContent !== false,
    compact: options.compact === true,
    contentLimit:
      options.includeContent === false || options.contentLimit === undefined
        ? null
        : Math.max(0, Math.min(100, Math.floor(options.contentLimit))),
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
  // The cap keeps the newest buckets, not the oldest: a series longer than the
  // cap is one whose recent days are the point of asking.
  const totalBuckets = Math.ceil((Date.parse(end) - Date.parse(start)) / (bucketSeconds * 1_000));
  const firstBucket = Math.max(0, totalBuckets - limitPerSeries);
  // One row per (post, target, metric, bucket), carrying that bucket's last
  // reading. SQLite hands back the row that produced max(sampled_at), which is
  // what a window function was doing here at twice the cost.
  return unsafeDb(backendDb)
    .sqlite.prepare(
      `SELECT post_key AS postKey, target, metric_name AS metricName, value, max(sampled_at) AS sampledAt, bucket
         FROM (
           SELECT post_key, target, metric_name, value, sampled_at,
                  CAST((unixepoch(sampled_at) - unixepoch(?)) / ? AS INTEGER) AS bucket
             FROM metric_samples
            WHERE post_key IN (${placeholders}) AND sampled_at >= ? AND sampled_at <= ?
         )
        WHERE bucket >= ?
        GROUP BY postKey, target, metricName, bucket
        ORDER BY postKey ASC, target ASC, metricName ASC, bucket ASC`,
    )
    .all(start, bucketSeconds, ...postKeys, start, end, firstBucket) as PipelineSampleRow[];
}

/** Stable revision for the pipeline read model. It must not be request time. */
/** The newest metric samples with the post they belong to. Both the pipeline
 * read model and the Command Center payload report this same list, and it was
 * written out twice, identically. */
export function recentPostMetrics(backendDb: BackendDb) {
  return unsafeDb(backendDb)
    .db.select({
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
}

export function pipelineUpdatedAt(backendDb: BackendDb): string | null {
  const row = unsafeDb(backendDb)
    .sqlite.prepare(
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
