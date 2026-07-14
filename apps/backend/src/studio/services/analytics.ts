import {
  audienceAnalysis,
  creatorPostArchive,
  creatorPostMetrics,
  creatorVideoArchive,
  creatorVideoMetrics,
  studioAnalyticsDashboard,
} from "../../analytics/engine.js";
import type { BackendConfig } from "../../config.js";
import type { BackendDb } from "../../db/client.js";
import type { StudioLocale as BotLocale } from "../locale.js";

type AnalyticsSection = "overview" | "posts" | "video";
type AnalyticsPeriod = 1 | 7 | 30;

/**
 * Application boundary for creator analytics. Telegram, Web Studio and MCP use
 * these operations instead of reaching into analytics tables or render helpers.
 */
export function analyticsService(backendDb: BackendDb, config: BackendConfig) {
  return {
    dashboard(section: AnalyticsSection, days: AnalyticsPeriod, locale: BotLocale) {
      return studioAnalyticsDashboard(backendDb, config, section, days, locale);
    },
    postArchive(offset: number, locale: BotLocale) {
      return creatorPostArchive(backendDb, offset, locale);
    },
    postMetrics(postId: number, locale: BotLocale) {
      return creatorPostMetrics(backendDb, postId, locale);
    },
    videoArchive(offset: number, locale: BotLocale) {
      return creatorVideoArchive(backendDb, offset, locale);
    },
    videoMetrics(videoDraftId: number, locale: BotLocale) {
      return creatorVideoMetrics(backendDb, videoDraftId, locale);
    },
    audienceAnalysis(locale: BotLocale) {
      return audienceAnalysis(backendDb, config, locale);
    },
  };
}
