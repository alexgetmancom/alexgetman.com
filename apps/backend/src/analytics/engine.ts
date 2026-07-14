import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { recordDomainEvent } from "../domain/events.js";
import { canSync } from "./creatorStore.js";
import { syncInstagramProfile, syncYouTubeProfile } from "./profileSync.js";
import { runVideoMetricSchedule } from "./videoMetrics.js";

export { audienceAnalysis } from "./audience.js";
export { creatorDashboard } from "./dashboard.js";
export { creatorPostArchive, creatorPostMetrics } from "./postArchive.js";
export { studioAnalyticsDashboard } from "./studioDashboard.js";
export { creatorVideoArchive, creatorVideoMetrics } from "./videoArchive.js";

/** Runs the transport-neutral analytics collection cycle. */
export async function runAnalyticsCycle(config: BackendConfig, backendDb: BackendDb, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!config.studio.modules.analytics || !config.studio.modules.video_posting) return 0;
  let profiles = 0;
  if (config.studio.modules.youtube && canSync(backendDb, "youtube")) {
    await syncYouTubeProfile(config, backendDb, fetchImpl);
    profiles += 1;
  }
  if (config.studio.modules.instagram && canSync(backendDb, "instagram")) {
    await syncInstagramProfile(config, backendDb, fetchImpl);
    profiles += 1;
  }
  const metrics = await runVideoMetricSchedule(config, backendDb, fetchImpl);
  const collected = profiles + metrics;
  if (collected)
    recordDomainEvent(backendDb, {
      ref: "analytics",
      type: "analytics.sync.completed",
      severity: "info",
      message: "Analytics collection completed",
      details: { profiles, metrics },
      cooldownSeconds: 60 * 60,
    });
  return collected;
}
