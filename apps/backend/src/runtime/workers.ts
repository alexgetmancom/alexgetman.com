import { runAnalyticsCycle } from "../analytics/collection/creator-cycle.js";
import { runMetricsCycle } from "../analytics/collection/metrics-cycle.js";
import { pruneMetricSamples } from "../analytics/snapshots/metric-repository.js";
import type { BackendDb } from "../db/client.js";
import { pruneMediaCache } from "../delivery/media-prepare.js";
import { createPlatformPorts } from "../delivery/ports/social.js";
import type { DeliveryPorts } from "../delivery/ports.js";
import { runPublicationReconciliation } from "../delivery/publication-reconciliation.js";
import { runDeliveryPublishCycle } from "../delivery/publish-workflow.js";
import { recoverStaleSiteJobs, runSiteJobCycle } from "../delivery/site-jobs.js";
import { runVideoCycle } from "../delivery/video-worker.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { recordWorkerHeartbeat } from "../foundation/runtime/worker-state.js";
import { type ScheduledLoop, startLoop } from "../foundation/scheduler.js";
import { runNotificationCycle } from "../notifications/jobs.js";
import { observabilityService } from "../observability/service.js";
import { pruneOperationalHistory, withMaintenanceLock } from "../operations/maintenance.js";
import { recoverStalePublishJobs } from "../publishing/queue.js";
import { recoverStoryCardJobs, runStoryCardCycle } from "../story-cards/worker.js";

/** Delivery-only publish cycle. Interfaces learn about settled work through durable events. */
export async function runPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: DeliveryPorts = createPlatformPorts(config),
): Promise<number> {
  return runDeliveryPublishCycle(config, backendDb, publishers);
}

/** Runs independently from delivery. A hung provider promise must never prevent
 * stale publishing locks from returning to the bounded retry policy. */
export function runPublishWatchdog(config: BackendConfig, backendDb: BackendDb): number {
  return recoverStalePublishJobs(backendDb, config);
}

/** Starts domain workers only. It deliberately has no Telegram or HTTP dependency. */
export function startCoreWorkers(config: BackendConfig, backendDb: BackendDb): ScheduledLoop[] {
  if (!config.ENABLE_WORKERS) {
    log("warn", "Workers are disabled by ENABLE_WORKERS");
    return [];
  }
  // Deployment/server restarts terminate the old process but leave its durable
  // locks behind. Do not wait the ordinary 15-minute crash TTL before the new
  // process can resume the same targets; the short grace still avoids racing a
  // request that was only just interrupted at the provider boundary.
  const recoveredAtStartup = recoverStalePublishJobs(backendDb, config, config.PUBLISH_RESTART_LOCK_GRACE_SECONDS);
  if (recoveredAtStartup) log("warn", "recovered interrupted publishing locks on worker startup", { recovered: recoveredAtStartup });
  const recoveredSiteAtStartup = recoverStaleSiteJobs(config, backendDb, config.SITE_JOB_RESTART_LOCK_GRACE_SECONDS);
  if (recoveredSiteAtStartup)
    log("warn", "recovered interrupted site build locks on worker startup", { recovered: recoveredSiteAtStartup });
  const recoveredStoryCardsAtStartup = recoverStoryCardJobs(backendDb);
  if (recoveredStoryCardsAtStartup)
    log("warn", "recovered interrupted Story card locks on worker startup", { recovered: recoveredStoryCardsAtStartup });
  const startWorkerLoop = (name: string, intervalMs: number, task: () => void | Promise<void>) => {
    const heartbeatIntervalMs = config.WORKER_HEARTBEAT_INTERVAL_SECONDS * 1000;
    return startLoop(name, intervalMs, task, {
      onStart: () => recordWorkerHeartbeat(backendDb, name, { phase: "running", heartbeat_interval_ms: heartbeatIntervalMs }),
      onHeartbeat: () => recordWorkerHeartbeat(backendDb, name, { phase: "running", heartbeat_interval_ms: heartbeatIntervalMs }),
      heartbeatIntervalMs,
      onFinish: (error) =>
        recordWorkerHeartbeat(
          backendDb,
          name,
          { phase: error ? "failed" : "idle", heartbeat_interval_ms: heartbeatIntervalMs },
          error instanceof Error ? error.message : error == null ? null : String(error),
        ),
    });
  };
  return [
    startWorkerLoop("story-cards", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const claimed = await runStoryCardCycle(config, backendDb);
      log("debug", "Story card loop tick", { claimed });
    }),
    startWorkerLoop("queue", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const claimed = await runPublishCycle(config, backendDb);
      log("debug", "queue loop tick", { claimed });
    }),
    startWorkerLoop("publish-watchdog", config.WATCHDOG_INTERVAL_SECONDS * 1000, async () => {
      const recovered = runPublishWatchdog(config, backendDb);
      if (recovered) log("warn", "recovered stale publishing locks", { recovered });
    }),
    startWorkerLoop("publication-reconciliation", Math.max(60, config.IDLE_POLL_INTERVAL_SECONDS) * 1000, async () => {
      const result = await runPublicationReconciliation(backendDb, config);
      log("debug", "publication reconciliation loop tick", result);
    }),
    startWorkerLoop("notifications", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const delivered = runNotificationCycle(backendDb);
      log("debug", "notification loop tick", { delivered });
    }),
    ...(config.studio.modules.video_posting
      ? [
          startWorkerLoop("video", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
            const claimed = await runVideoCycle(config, backendDb);
            log("debug", "video loop tick", { claimed });
          }),
        ]
      : []),
    ...(config.studio.modules.analytics
      ? [
          // Two independent collectors on one schedule. They do not share a
          // failure: a provider outage on one must not silently stop the other.
          startWorkerLoop("metrics", config.METRICS_REFRESH_INTERVAL_SECONDS * 1000, async () => {
            const checked = await runMetricsCycle(config, backendDb);
            log("debug", "metrics loop tick", { checked });
          }),
          startWorkerLoop("creator-analytics", config.PROFILE_POLL_INTERVAL_SECONDS * 1000, async () => {
            const creators = await runAnalyticsCycle(config, backendDb);
            log("debug", "creator analytics loop tick", { creators });
          }),
          // Retention is a housekeeping concern, not a collection one: it used
          // to run on every metrics tick (10s by default), scanning
          // metric_samples for a window that moves by a day at a time.
          startWorkerLoop("metric-retention", 60 * 60 * 1000, async () => {
            try {
              pruneMetricSamples(backendDb);
            } catch (error) {
              log("error", "failed to prune old metric samples", { error: error instanceof Error ? error.message : String(error) });
            }
          }),
        ]
      : []),
    ...(config.studio.modules.site
      ? [
          startWorkerLoop("site", config.SITE_JOB_POLL_INTERVAL_SECONDS * 1000, async () => {
            const claimed = await runSiteJobCycle(config, backendDb);
            log("debug", "site materialization loop tick", { claimed });
          }),
        ]
      : []),
    ...(config.studio.modules.site
      ? [
          startWorkerLoop("site-watchdog", config.WATCHDOG_INTERVAL_SECONDS * 1000, async () => {
            const recovered = recoverStaleSiteJobs(config, backendDb);
            if (recovered) log("warn", "recovered stale site build locks", { recovered });
          }),
        ]
      : []),
    startWorkerLoop("media-cache", 60 * 60 * 1000, async () => {
      const removed = await pruneMediaCache(config);
      if (removed) log("info", "pruned expired media cache", { removed });
    }),
    startWorkerLoop("operational-retention", 24 * 60 * 60 * 1000, async () => {
      const result = withMaintenanceLock(backendDb, () => pruneOperationalHistory(backendDb, config));
      if (result.total) log("info", "pruned operational history", result);
    }),
    startWorkerLoop("observability", config.OBSERVABILITY_INTERVAL_SECONDS * 1000, async () => {
      const result = await observabilityService(backendDb, config).run();
      log("debug", "observability loop tick", result);
    }),
  ];
}
