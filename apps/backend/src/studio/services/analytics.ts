import { audienceAnalysis } from "../../analytics/reports/audience.js";
import { creatorArchiveSummary, creatorPostArchive, creatorPostMedia, creatorPostMetrics } from "../../analytics/reports/post-archive.js";
import { studioAnalyticsDashboard } from "../../analytics/reports/studio-dashboard.js";
import { creatorVideoArchive, creatorVideoMetrics } from "../../analytics/reports/video-archive.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale as BotLocale } from "../../foundation/locale.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";
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
    postMedia(postId: number, locale: BotLocale) {
      return creatorPostMedia(backendDb, postId, locale);
    },
    archiveSummary(locale: BotLocale) {
      return creatorArchiveSummary(backendDb, config.studio.modules.video_posting, locale);
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
