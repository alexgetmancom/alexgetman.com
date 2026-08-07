import { audienceAnalysis } from "../../analytics/reports/audience.js";
import { creatorArchiveSummary, creatorPostArchive, creatorPostMedia, creatorPostMetrics } from "../../analytics/reports/post-archive.js";
import { studioAnalyticsDashboard } from "../../analytics/reports/studio-dashboard.js";
import { creatorVideoArchive, creatorVideoMetrics } from "../../analytics/reports/video-archive.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";

type AnalyticsSection = "overview" | "audience" | "posts" | "video";
type AnalyticsPeriod = 1 | 7 | 30;

/**
 * Application boundary for creator analytics. Telegram, Web Studio and MCP use
 * these operations instead of reaching into analytics tables or render helpers.
 */
export function analyticsService(backendDb: BackendDb, config: BackendConfig) {
  return {
    dashboard(section: AnalyticsSection, days: AnalyticsPeriod, locale: StudioLocale) {
      return studioAnalyticsDashboard(backendDb, config, section, days, locale);
    },
    postArchive(offset: number, locale: StudioLocale) {
      return creatorPostArchive(backendDb, offset, locale);
    },
    postMetrics(postId: number, locale: StudioLocale) {
      return creatorPostMetrics(backendDb, postId, locale);
    },
    postMedia(postId: number, locale: StudioLocale) {
      return creatorPostMedia(backendDb, postId, locale);
    },
    archiveSummary(locale: StudioLocale) {
      return creatorArchiveSummary(backendDb, config.studio.modules.video_posting, locale);
    },
    videoArchive(offset: number, locale: StudioLocale) {
      return creatorVideoArchive(backendDb, offset, locale);
    },
    videoMetrics(publicationId: number, locale: StudioLocale) {
      return creatorVideoMetrics(backendDb, publicationId, locale, config.TIMEZONE);
    },
    audienceAnalysis(locale: StudioLocale) {
      return audienceAnalysis(backendDb, config, locale);
    },
  };
}
