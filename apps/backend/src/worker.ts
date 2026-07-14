import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import { runAnalyticsCycle } from "./analytics/engine.js";
import { runMetricsCycle } from "./analytics/metrics.js";
import { finalizePendingAlbums } from "./bot/albums.js";
import { refreshPostControlCard } from "./bot/progress.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { drafts } from "./db/schema.js";
import { pruneMediaCache } from "./delivery/media.js";
import { runDeliveryPublishCycle } from "./delivery/publish-cycle.js";
import { createPublishers, type Publisher } from "./delivery/publishers.js";
import { runSiteJobCycle } from "./delivery/site.js";
import { runVideoCycle } from "./delivery/video.js";
import { sendWeeklyAnalyticsSummary } from "./interfaces/telegram/analytics-summary.js";
import { notifyFinalVideoFailure, refreshVideoControlCard, sendVideoReminder } from "./interfaces/telegram/video-notifications.js";
import { log } from "./logger.js";
import { runObservabilityCycle } from "./operations/observability.js";
import { type ScheduledLoop, startLoop } from "./scheduler.js";

export async function runPublishCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  publishers: Record<string, Publisher> = createPublishers(config, backendDb),
  bot: Bot | null = null,
): Promise<number> {
  return runDeliveryPublishCycle(config, backendDb, publishers, async (postIds) => {
    if (!bot) return;
    for (const postId of postIds) {
      const draft = backendDb.db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, postId)).get();
      if (draft) await refreshPostControlCard(backendDb, bot, draft.id);
    }
  });
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
            const claimed = await runVideoCycle(config, backendDb, {
              sendReminder: (job) => sendVideoReminder(backendDb, bot, job.videoDraftId, job.videoTargetId, config.VIDEO_REMINDER_MINUTES),
              notifyFinalFailure: (job) => notifyFinalVideoFailure(backendDb, bot, job),
              refreshProgress: (videoDraftId) => refreshVideoControlCard(backendDb, bot, videoDraftId),
            });
            log("debug", "video loop tick", { claimed });
          }),
        ]
      : []),
    ...(config.studio.modules.analytics
      ? [
          startLoop("metrics", config.METRICS_REFRESH_INTERVAL_SECONDS * 1000, async () => {
            const checked = await runMetricsCycle(config, backendDb);
            const creators = await runAnalyticsCycle(config, backendDb);
            const weeklySummary = await sendWeeklyAnalyticsSummary(config, backendDb, bot);
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
