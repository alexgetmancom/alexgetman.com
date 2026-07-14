import { and, eq } from "drizzle-orm";
import type { Bot } from "grammy";
import pLimit from "p-limit";
import { runCreatorAnalyticsCycle, runWeeklyCreatorSummary } from "./analytics/creator.js";
import { finalizePendingAlbums } from "./bot/albums.js";
import { refreshPostControlCard } from "./bot/progress.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { drafts, postTargets, publishJobs } from "./db/schema.js";
import { log } from "./logger.js";
import { pruneMediaCache } from "./media/prepare.js";
import { runMetricsCycle } from "./metrics/index.js";
import { claimDuePublishJobs, completePublishJob, failPublishJob, recoverStalePublishJobs } from "./publishing/queue.js";
import { type ScheduledLoop, startLoop } from "./scheduler.js";
import { runObservabilityCycle } from "./services/observability.js";
import { recordWorkerState } from "./services/workerState.js";
import { runSiteJobCycle } from "./site/jobs.js";
import { createPublishers, type Publisher } from "./social/index.js";
import { runVideoCycle } from "./video/service.js";

export async function runPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: Record<string, Publisher> = createPublishers(config, backendDb),
  bot: Bot | null = null,
): Promise<number> {
  recoverStalePublishJobs(backendDb, config.PUBLISH_LOCK_TIMEOUT_SECONDS);
  const jobs = claimDuePublishJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  const publishLimit = pLimit(config.PUBLISH_MAX_CONCURRENCY);
  const results = await Promise.allSettled(
    jobs.map((job) =>
      publishLimit(async () => {
        const publisher = publishers[job.target];
        if (!publisher) {
          completePublishJob(backendDb, config, job.jobId, { skipped: true, reason: `unsupported target: ${job.target}` }, job.lockId);
          return;
        }
        try {
          completePublishJob(backendDb, config, job.jobId, await publisher(job), job.lockId);
        } catch (error) {
          failPublishJob(backendDb, config, job.jobId, error, job.lockId);
        }
      }),
    ),
  );
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    const job = jobs[index];
    if (!job) continue;
    const error = `worker finalization failed: ${String(result.reason instanceof Error ? result.reason.message : result.reason)}`;
    log("error", "publish job finalization failed", { jobId: job.jobId, target: job.target, error });
    const now = new Date().toISOString();
    backendDb.db
      .update(publishJobs)
      .set({ status: "failed", lockedBy: null, lockedAt: null, lastError: error, updatedAt: now })
      .where(and(eq(publishJobs.jobId, job.jobId), eq(publishJobs.status, "publishing")))
      .run();
    backendDb.db
      .update(postTargets)
      .set({ status: "failed", error, skipped: 0, updatedAt: now })
      .where(and(eq(postTargets.postKey, job.postKey), eq(postTargets.target, job.target)))
      .run();
  }
  if (bot && jobs.length) {
    const postIds = [...new Set(jobs.map((job) => job.postId).filter((id): id is number => id != null))];
    for (const postId of postIds) {
      const draft = backendDb.db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, postId)).get();
      if (draft) await refreshPostControlCard(backendDb, bot, draft.id);
    }
  }
  recordWorkerState(backendDb, "queue", { claimed: jobs.length });
  return jobs.length;
}

export function startWorkers(config: BackendConfig, backendDb: BackendDb, bot: Bot | null = null): ScheduledLoop[] {
  if (!config.ENABLE_WORKERS) {
    log("warn", "Workers are disabled by ENABLE_WORKERS");
    return [];
  }
  return [
    startLoop("albums", 1000, async () => {
      const completed = await finalizePendingAlbums(bot, backendDb, config);
      if (completed) log("info", "album drafts finalized", { completed });
    }),
    startLoop("queue", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const claimed = await runPublishCycle(config, backendDb, undefined, bot);
      log("debug", "queue loop tick", { claimed });
    }),
    ...(config.studio.modules.video_posting
      ? [
          startLoop("video", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
            const claimed = await runVideoCycle(config, backendDb, bot);
            log("debug", "video loop tick", { claimed });
          }),
        ]
      : []),
    ...(config.studio.modules.analytics
      ? [
          startLoop("metrics", config.METRICS_REFRESH_INTERVAL_SECONDS * 1000, async () => {
            const checked = await runMetricsCycle(config, backendDb);
            const creators = await runCreatorAnalyticsCycle(config, backendDb);
            const weeklySummary = await runWeeklyCreatorSummary(config, backendDb, bot);
            log("debug", "metrics loop tick", { checked, creators, weeklySummary });
          }),
        ]
      : []),
    ...(config.studio.modules.site
      ? [
          startLoop("site", config.METRICS_REFRESH_INTERVAL_SECONDS * 1000, async () => {
            const claimed = await runSiteJobCycle(config, backendDb);
            log("debug", "site materialization loop tick", { claimed });
          }),
        ]
      : []),
    startLoop("media-cache", 60 * 60 * 1000, async () => {
      const removed = await pruneMediaCache(config);
      if (removed) log("info", "pruned expired media cache", { removed });
    }),
    startLoop("observability", config.OBSERVABILITY_INTERVAL_SECONDS * 1000, async () => {
      const result = await runObservabilityCycle(config, backendDb, bot);
      log("debug", "observability loop tick", result);
    }),
  ];
}
