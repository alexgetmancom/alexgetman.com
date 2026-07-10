import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { log } from "./logger.js";
import { runMetricsCycle } from "./metrics/index.js";
import { claimDuePublishJobs, completePublishJob, failPublishJob, recoverStalePublishJobs } from "./queue/publish.js";
import { startLoop, type ScheduledLoop } from "./scheduler.js";
import { runSiteJobCycle } from "./site/jobs.js";
import { createPublishers, type Publisher } from "./social/index.js";
import { recordWorkerState } from "./services/workerState.js";
import type { Bot } from "grammy";
import { finalizePendingAlbums } from "./bot.js";
import { runObservabilityCycle } from "./services/observability.js";

export async function runPublishCycle(config: BackendConfig, backendDb: BackendDb, publishers: Record<string, Publisher> = createPublishers(config, backendDb)): Promise<number> {
  recoverStalePublishJobs(backendDb, config.PUBLISH_LOCK_TIMEOUT_SECONDS);
  const jobs = claimDuePublishJobs(backendDb, config.PUBLISH_CLAIM_LIMIT);
  await Promise.allSettled(
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
      log("debug", "queue loop tick", { claimed });
    }),
    startLoop("metrics", config.METRICS_REFRESH_INTERVAL_SECONDS * 1000, async () => {
      const claimed = await runSiteJobCycle(config, backendDb);
      const checked = await runMetricsCycle(config, backendDb);
      log("debug", "site/metrics loop tick", { claimed, checked });
    }),
    startLoop("observability", config.OBSERVABILITY_INTERVAL_SECONDS * 1000, async () => {
      const result = await runObservabilityCycle(config, backendDb, bot);
      log("debug", "observability loop tick", result);
    }),
  ];
}
