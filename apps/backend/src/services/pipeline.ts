import { existsSync, readFileSync } from "node:fs";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { TARGETS } from "../botTargets.js";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { type JsonValue, metricSamples, postMetrics, posts, postTargets, publishJobs, siteJobs, workerState } from "../db/schema.js";
import { gitRevision } from "../runtime/git.js";

export function pipelineStatusPayload(config: BackendConfig, backendDb: BackendDb, weekOffset = 0) {
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
  const latestSiteJobs = backendDb.sqlite
    .prepare(
      "SELECT job_id, post_id, message_id, reason, status, attempt_count, last_error, created_at, updated_at FROM site_jobs ORDER BY updated_at DESC, job_id DESC LIMIT 25",
    )
    .all();
  const recentMetrics = backendDb.sqlite
    .prepare(
      `SELECT m.post_key, m.target, m.metric_name, m.value, m.source, m.sampled_at, m.error,
              p.message_id, COALESCE(p.site_en_path, p.site_ru_path, p.telegram_url) AS post_url
       FROM post_metrics m LEFT JOIN posts p ON p.post_key=m.post_key
       ORDER BY m.sampled_at DESC, m.post_key, m.target, m.metric_name LIMIT 100`,
    )
    .all();
  const metricSchedule = backendDb.sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN frozen_at IS NOT NULL THEN 1 ELSE 0 END) AS frozen,
         SUM(CASE WHEN frozen_at IS NULL AND (next_check_at IS NULL OR next_check_at <= ?) THEN 1 ELSE 0 END) AS due,
         SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
         MAX(last_checked_at) AS last_checked_at
       FROM metric_schedule`,
    )
    .get(new Date().toISOString());
  const legacyPosts = legacyPipelinePosts(backendDb, weekOffset);
  const feed = readFeedSummary(config);
  const socialState = readWorkerState(backendDb, "crosspost_worker") ?? readWorkerState(backendDb, "queue") ?? {};
  const currentTargetFailures = backendDb.db
    .select({ postKey: postTargets.postKey })
    .from(postTargets)
    .where(eq(postTargets.status, "failed"))
    .all().length;
  const currentSiteFailures = backendDb.db
    .select({ jobId: siteJobs.jobId })
    .from(siteJobs)
    .where(eq(siteJobs.status, "failed"))
    .all().length;

  return {
    ok: currentTargetFailures === 0 && currentSiteFailures === 0 && workers.every((worker) => worker.ok),
    generatedAt: new Date().toISOString(),
    gitRevision: gitRevision(),
    pipelineDb: {
      path: config.PIPELINE_DB,
      exists: existsSync(config.PIPELINE_DB),
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
      schedule: metricSchedule,
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
    posts: legacyPosts,
  };
}

function legacyPipelinePosts(backendDb: BackendDb, weekOffset: number): Record<string, unknown>[] {
  const [start, end] = weekBounds(weekOffset);
  const rows = backendDb.sqlite
    .prepare(
      `SELECT 'post:' || p.post_id AS post_key, p.post_id, p.telegram_message_id, p.created_at AS created_at, p.updated_at,
            ru.text AS text_ru, ru.media_json AS media_ru_json, ru.site_enabled AS site_ru, ru.slug AS slug_ru,
            en.text AS text_en, en.media_json AS media_en_json, en.site_enabled AS site_en, en.slug AS slug_en,
            po.message_id, po.date_msk, po.telegram_url
     FROM publications p
     LEFT JOIN post_locales ru ON ru.post_id=p.post_id AND ru.locale='ru'
     LEFT JOIN post_locales en ON en.post_id=p.post_id AND en.locale='en'
     LEFT JOIN posts po ON po.post_key='post:' || p.post_id
     WHERE p.created_at>=? AND p.created_at<=?
     UNION ALL
     SELECT po.post_key, NULL, po.message_id, po.date_utc, po.updated_at,
            po.text, po.media_json, 0, NULL,
            po.text_en, po.media_json, 0, NULL,
            po.message_id, po.date_msk, po.telegram_url
     FROM posts po
     WHERE po.post_key LIKE 'telegram:%' AND po.date_utc>=? AND po.date_utc<=?
     ORDER BY 4 DESC LIMIT 100`,
    )
    .all(start, end, start, end) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const postId = row.post_id == null ? null : Number(row.post_id);
    const postKey = String(row.post_key ?? `post:${postId}`);
    const targets = Object.fromEntries(
      (
        backendDb.sqlite
          .prepare(
            "SELECT target,status,external_id,external_ids_json,url,error,skipped,updated_at,raw_json FROM post_targets WHERE post_key=? ORDER BY target",
          )
          .all(postKey) as Array<Record<string, unknown>>
      ).map((target) => [
        String(target.target),
        {
          status: target.status,
          ok: target.status === "published",
          external_id: target.external_id,
          external_ids: parseArray(target.external_ids_json),
          url: target.url,
          error: target.error,
          skipped: Boolean(target.skipped),
          updated_at: target.updated_at,
          raw: parseObject(target.raw_json),
        },
      ]),
    );
    const metrics: Record<string, Record<string, unknown>> = {};
    for (const metric of backendDb.sqlite
      .prepare(
        "SELECT target,metric_name,value,sampled_at,source,error,raw_json FROM post_metrics WHERE post_key=? ORDER BY target,metric_name",
      )
      .all(postKey) as Array<Record<string, unknown>>) {
      const target = String(metric.target);
      const targetMetrics = metrics[target] ?? {};
      metrics[target] = targetMetrics;
      targetMetrics[String(metric.metric_name)] = {
        value: metric.value,
        sampled_at: metric.sampled_at,
        source: metric.source,
        error: metric.error,
        raw: parseObject(metric.raw_json),
      };
    }
    const mediaRu = parseArray(row.media_ru_json);
    const mediaEn = parseArray(row.media_en_json);
    const textRu = String(row.text_ru ?? "");
    const textEn = String(row.text_en ?? "");
    const telegramMessageId = row.telegram_message_id == null ? null : Number(row.telegram_message_id);
    const telegramUrl =
      typeof row.telegram_url === "string" && row.telegram_url
        ? row.telegram_url
        : telegramMessageId
          ? `https://t.me/${configlessChannel(backendDb)}/${telegramMessageId}`
          : null;
    const localesMap = { ru: { site_enabled: Number(row.site_ru ?? 0) }, en: { site_enabled: Number(row.site_en ?? 0) } };
    const result: Record<string, unknown> = {
      post_id: postId,
      message_id: postId,
      telegram_message_id: telegramMessageId,
      date: row.created_at,
      date_msk: row.date_msk ?? formatMskDate(String(row.created_at)),
      text_ru: shortText(textRu),
      text_en: shortText(textEn),
      full_text_ru: textRu,
      full_text_en: textEn,
      text: shortText(textRu),
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

function readFeedSummary(config: BackendConfig): { channel: string; updated_at: unknown; items: number } {
  try {
    const value = JSON.parse(readFileSync(config.FEED_JSON, "utf8")) as { channel?: string; updated_at?: unknown; items?: unknown[] };
    return {
      channel: value.channel ?? config.CHANNEL_USERNAME,
      updated_at: value.updated_at ?? null,
      items: Array.isArray(value.items) ? value.items.length : 0,
    };
  } catch {
    return { channel: config.CHANNEL_USERNAME, updated_at: null, items: 0 };
  }
}

function readWorkerState(backendDb: BackendDb, name: string): Record<string, unknown> | null {
  const row = backendDb.db.select({ stateJson: workerState.stateJson }).from(workerState).where(eq(workerState.name, name)).get();
  return row?.stateJson ?? null;
}

function weekBounds(offset: number): [string, string] {
  const nowMsk = new Date(Date.now() + 3 * 3_600_000);
  const weekday = (nowMsk.getUTCDay() + 6) % 7;
  const start = Date.UTC(nowMsk.getUTCFullYear(), nowMsk.getUTCMonth(), nowMsk.getUTCDate() - weekday - offset * 7, -3, 0, 0);
  return [new Date(start).toISOString(), new Date(start + 7 * 86_400_000 - 1).toISOString()];
}

function parseArray(value: unknown): unknown[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function shortText(value: string): string {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.length <= 7 ? words.join(" ") : `${words.slice(0, 7).join(" ")}...`;
}

function formatMskDate(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function configlessChannel(backendDb: BackendDb): string {
  const row = backendDb.db.select({ channel: posts.channel }).from(posts).where(ne(posts.channel, "")).orderBy(desc(posts.updatedAt)).get();
  return row?.channel.replace(/^@/, "") || "alexgetmancom";
}
