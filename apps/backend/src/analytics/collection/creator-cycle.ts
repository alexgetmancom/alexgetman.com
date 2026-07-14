import type { BackendDb } from "../../db/client.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { canSync } from "../snapshots/creator-store.js";
import { syncInstagramProfile, syncYouTubeProfile } from "./profile-sync.js";
import { runVideoMetricSchedule } from "./video-metrics.js";

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
