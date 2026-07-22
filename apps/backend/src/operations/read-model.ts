import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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
import { formatZonedSortable, zonedWeekBounds } from "../foundation/time.js";
import { jsonArray, jsonObject } from "../json.js";

/** Operations read model over publication, delivery and worker state. */
export function pipelineStatusPayload(config: BackendConfig, backendDb: BackendDb, weekOffset = 0, periodDays = 7) {
  const jobs = backendDb.db
    .select()
    .from(publishJobs)
    .orderBy(desc(publishJobs.updatedAt))
    .limit(50)
    .all()
    .map((job) => ({
      jobId: job.jobId,
      postId: job.postId,
      postKey: job.postKey,
      messageId: job.messageId,
      target: job.target,
      status: job.status,
      attemptCount: job.attemptCount,
      publishAt: job.publishAt,
      nextAttemptAt: job.nextAttemptAt,
      lastError: job.lastError,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));

  const workers = backendDb.db
    .select()
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
  const latestSiteJobs = backendDb.db.select().from(siteJobs).orderBy(desc(siteJobs.updatedAt), desc(siteJobs.jobId)).limit(25).all();
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
      errors: sql<number>`sum(case when ${metricSchedule.lastError} is not null then 1 else 0 end)`,
      lastCheckedAt: sql<string | null>`max(${metricSchedule.lastCheckedAt})`,
    })
    .from(metricSchedule)
    .all();
  const pipelinePostRows = pipelinePosts(backendDb, config, weekOffset, periodDays);
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

  return {
    ok: Number(targetFailureCount?.count ?? 0) === 0 && Number(siteFailureCount?.count ?? 0) === 0 && workers.every((worker) => worker.ok),
    generatedAt: new Date().toISOString(),
    gitRevision: gitRevision(),
    pipelineDb: {
      path: config.PIPELINE_DB,
      exists: true,
    },
    jobs,
    siteJobs: latestSiteJobs,
    workers,
    metrics: {
      generatedAt: new Date().toISOString(),
      posts: Number(postCount?.count ?? 0),
      targets: Number(targetCount?.count ?? 0),
      metrics: Number(metricCount?.count ?? 0),
      samples: Number(sampleCount?.count ?? 0),
      schedule: metricScheduleSummary,
      recent: recentMetrics,
    },
    updated_at: new Date().toISOString(),
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

function pipelinePosts(backendDb: BackendDb, config: BackendConfig, weekOffset: number, periodDays: number): Record<string, unknown>[] {
  const [weekStart, weekEnd] = zonedWeekBounds(weekOffset, config.TIMEZONE);
  const endDate = new Date(weekEnd);
  const start = periodDays === 7 ? weekStart : new Date(endDate.getTime() - (periodDays - 1) * 86_400_000).toISOString();
  const end = weekEnd;
  const rows = fetchPostRows(backendDb, start, end);
  const postKeys = rows.map((row) => String(row.post_key ?? "")).filter(Boolean);
  const targetRows = postKeys.length
    ? backendDb.db.select().from(postTargets).where(inArray(postTargets.postKey, postKeys)).orderBy(asc(postTargets.target)).all()
    : [];
  const metricRows = postKeys.length
    ? backendDb.db
        .select()
        .from(postMetrics)
        .where(inArray(postMetrics.postKey, postKeys))
        .orderBy(asc(postMetrics.target), asc(postMetrics.metricName))
        .all()
    : [];
  return formatPipelinePosts(config, rows, targetRows, metricRows);
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
    .where(and(sql`${publications.createdAt} >= ${start}`, sql`${publications.createdAt} <= ${end}`))
    .all();
  const publicationKeys = publicationRows.map((row) => `post:${row.postId}`);
  const publicationPosts = publicationKeys.length
    ? backendDb.db.select().from(posts).where(inArray(posts.postKey, publicationKeys)).all()
    : [];
  const postByKey = new Map(publicationPosts.map((post) => [post.postKey, post]));
  return publicationRows
    .map((row) => {
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
    })
    .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))
    .slice(0, 100);
}

function formatPipelinePosts(
  config: BackendConfig,
  rows: ReturnType<typeof fetchPostRows>,
  targetRows: Array<typeof postTargets.$inferSelect>,
  metricRows: Array<typeof postMetrics.$inferSelect>,
): Record<string, unknown>[] {
  const targetsByPost = new Map<string, (typeof targetRows)[number][]>();
  for (const target of targetRows) {
    const values = targetsByPost.get(target.postKey) ?? [];
    values.push(target);
    targetsByPost.set(target.postKey, values);
  }
  const metricsByPost = new Map<string, (typeof metricRows)[number][]>();
  for (const metric of metricRows) {
    const values = metricsByPost.get(metric.postKey) ?? [];
    values.push(metric);
    metricsByPost.set(metric.postKey, values);
  }
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
          raw: jsonObject(target.rawJson),
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
        raw: metric.rawJson ?? {},
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
      message_id: postId,
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
