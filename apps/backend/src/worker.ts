import type { Bot } from "grammy";
import { finalizePendingAlbums } from "./bot.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { log } from "./logger.js";
import { runMetricsCycle } from "./metrics/index.js";
import { claimDuePublishJobs, completePublishJob, failPublishJob, recoverStalePublishJobs } from "./queue/publish.js";
import { type ScheduledLoop, startLoop } from "./scheduler.js";
import { runObservabilityCycle } from "./services/observability.js";
import { recordWorkerState } from "./services/workerState.js";
import { runSiteJobCycle } from "./site/jobs.js";
import { createPublishers, type Publisher } from "./social/index.js";

export async function runPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: Record<string, Publisher> = createPublishers(config, backendDb),
): Promise<number> {
  recoverStalePublishJobs(backendDb, config.PUBLISH_LOCK_TIMEOUT_SECONDS);
  const jobs = claimDuePublishJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      const publisher = publishers[job.target];
      if (!publisher) {
        completePublishJob(backendDb, job.jobId, { skipped: true, reason: `unsupported target: ${job.target}` });
        return;
      }
      try {
        completePublishJob(backendDb, job.jobId, await publisher(job));
      } catch (error) {
        failPublishJob(backendDb, config, job.jobId, error);
      }
    }),
  );
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    const job = jobs[index]!;
    const error = `worker finalization failed: ${String(result.reason instanceof Error ? result.reason.message : result.reason)}`;
    log("error", "publish job finalization failed", { jobId: job.jobId, target: job.target, error });
    const now = new Date().toISOString();
    backendDb.sqlite
      .prepare(
        "UPDATE publish_jobs SET status='failed', locked_by=NULL, locked_at=NULL, last_error=?, updated_at=? WHERE job_id=? AND status='publishing'",
      )
      .run(error, now, job.jobId);
    backendDb.sqlite
      .prepare("UPDATE post_targets SET status='failed', error=?, skipped=0, updated_at=? WHERE post_key=? AND target=?")
      .run(error, now, job.postKey, job.target);
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
      const claimed = await runPublishCycle(config, backendDb);
      if (claimed > 0 && config.ENABLE_SITE_WORKER) {
        const siteClaimed = await runSiteJobCycle(config, backendDb);
        if (siteClaimed) log("debug", "site build triggered by publish cycle", { claimed: siteClaimed });
      }
      log("debug", "queue loop tick", { claimed });
    }),
    startLoop("metrics", config.METRICS_REFRESH_INTERVAL_SECONDS * 1000, async () => {
      const claimed = config.ENABLE_SITE_WORKER ? await runSiteJobCycle(config, backendDb) : 0;
      const checked = await runMetricsCycle(config, backendDb);
      log("debug", "site/metrics loop tick", { claimed, checked });
    }),
    startLoop("observability", config.OBSERVABILITY_INTERVAL_SECONDS * 1000, async () => {
      const result = await runObservabilityCycle(config, backendDb, bot);
      log("debug", "observability loop tick", result);
    }),
  ];
}
