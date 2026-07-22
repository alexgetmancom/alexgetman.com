import { runAnalyticsCycle } from "../analytics/collection/creator-cycle.js";
import { runMetricsCycle } from "../analytics/collection/metrics-cycle.js";
import type { BackendDb } from "../db/client.js";
import { pruneMediaCache } from "../delivery/media-prepare.js";
import { createPlatformPorts } from "../delivery/ports/social.js";
import type { DeliveryPort, DeliveryPorts } from "../delivery/ports.js";
import { runDeliveryPublishCycle } from "../delivery/publish-workflow.js";
import { runSiteJobCycle } from "../delivery/site-jobs.js";
import { runVideoCycle } from "../delivery/video-worker.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { type ScheduledLoop, startLoop } from "../foundation/scheduler.js";
import { runNotificationCycle } from "../notifications/jobs.js";
import { observabilityService } from "../observability/service.js";
import { recoverStalePublishJobs } from "../publishing/queue.js";

/** Delivery-only publish cycle. Interfaces learn about settled work through durable events. */
export async function runPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: DeliveryPorts | Record<string, DeliveryPort> = createPlatformPorts(config),
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
  return [
    startLoop("queue", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const claimed = await runPublishCycle(config, backendDb);
      log("debug", "queue loop tick", { claimed });
    }),
    startLoop("publish-watchdog", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const recovered = runPublishWatchdog(config, backendDb);
      if (recovered) log("warn", "recovered stale publishing locks", { recovered });
    }),
    startLoop("notifications", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const delivered = runNotificationCycle(backendDb);
      log("debug", "notification loop tick", { delivered });
    }),
    ...(config.studio.modules.video_posting
      ? [
          startLoop("video", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
            const claimed = await runVideoCycle(config, backendDb);
            log("debug", "video loop tick", { claimed });
          }),
        ]
      : []),
    ...(config.studio.modules.analytics
      ? [
          startLoop("metrics", config.METRICS_REFRESH_INTERVAL_SECONDS * 1000, async () => {
            const checked = await runMetricsCycle(config, backendDb);
            const creators = await runAnalyticsCycle(config, backendDb);
            log("debug", "metrics loop tick", { checked, creators });
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
      const result = await observabilityService(backendDb, config).run();
      log("debug", "observability loop tick", result);
    }),
  ];
}
