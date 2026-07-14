import { eq } from "drizzle-orm";
import type { Bot } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { analyticsSync } from "../db/schema.js";
import { canSync, markSynced } from "./creatorStore.js";
import { creatorDashboard } from "./dashboard.js";
import { syncInstagramProfile, syncYouTubeProfile } from "./profileSync.js";
import { runVideoMetricSchedule } from "./videoMetrics.js";

export { audienceAnalysis } from "./audience.js";
export { creatorDashboard } from "./dashboard.js";
export { creatorPostArchive, creatorPostMetrics } from "./postArchive.js";
export { type AnalyticsPeriod, type AnalyticsSection, studioAnalyticsDashboard } from "./studioDashboard.js";
export { creatorVideoArchive, creatorVideoMetrics } from "./videoArchive.js";

export async function runCreatorAnalyticsCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!config.studio.modules.analytics || !config.studio.modules.video_posting) return 0;
  let synced = 0;
  if (config.studio.modules.youtube && canSync(backendDb, "youtube")) {
    await syncYouTubeProfile(config, backendDb, fetchImpl);
    synced += 1;
  }
  if (config.studio.modules.instagram && canSync(backendDb, "instagram")) {
    await syncInstagramProfile(config, backendDb, fetchImpl);
    synced += 1;
  }
  return synced + (await runVideoMetricSchedule(config, backendDb, fetchImpl));
}

/** Sends one creator-summary each Sunday after 21:00 Moscow time. */
export async function runWeeklyCreatorSummary(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
): Promise<boolean> {
  if (!bot || !config.studio.modules.analytics || !config.studio.modules.video_posting) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  if (parts.weekday !== "Sun" || Number(parts.hour) < 21) return false;
  const key = `weekly_summary:${parts.year}-${parts.month}-${parts.day}`;
  if (backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, key)).get()) return false;
  const report = creatorDashboard(backendDb, config, 7).text.replace("📊 *Статистика за 7 дней*", "📊 *Итоги недели*");
  for (const adminId of config.ADMIN_IDS) await bot.api.sendMessage(adminId, report, { parse_mode: "Markdown" });
  markSynced(backendDb, key);
  return true;
}
