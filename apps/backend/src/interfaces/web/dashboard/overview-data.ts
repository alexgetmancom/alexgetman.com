import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { xActivityDashboard } from "../../../analytics/x-activity-dashboard.js";
import type { AudienceView } from "../../../botTargets.js";
import type { BackendDb } from "../../../db/client.js";
import type { BackendConfig } from "../../../foundation/config.js";
import { zonedSlot } from "../../../foundation/time.js";
import type { operationsService } from "../../../operations/index.js";
import type { CombinedSectionInput, PlatformMetric } from "./combined-section.js";
import { audiencePlatformFollowers } from "./ops-sections.js";
import { rollingPeriodDates } from "./period-controls.js";
import type { PipelineData, PipelinePost } from "./types.js";
import {
  createVideoOverviewCache,
  emptyVideoOverview,
  setVideoOverviewCacheRange,
  type VideoOverview,
  videoOverview,
} from "./video-overview.js";

type OverviewService = ReturnType<typeof operationsService>;
type OverviewCache = ReturnType<typeof createVideoOverviewCache>;

export function buildOverviewData(
  config: BackendConfig,
  backendDb: BackendDb,
  service: OverviewService,
  videoCache: OverviewCache,
  weekOffset: number,
  periodDays: number,
  activeView: AudienceView | undefined,
  platformMetric: PlatformMetric,
): CombinedSectionInput {
  const [start, end] = rollingPeriodDates(weekOffset, periodDays, config.TIMEZONE);
  const selectedTargetIds = activeView ? [activeView] : undefined;
  const selectPipeline = (data: PipelineData | null): PipelineData | null =>
    selectedTargetIds ? filterPipeline(data, selectedTargetIds) : data;
  const selectX = (items: XActivityDashboardItem[]): XActivityDashboardItem[] => (!activeView ? items : activeView === "x" ? items : []);
  const comparisonPipeline =
    periodDays === 1
      ? selectPipeline(service.pipelineOverview(0, 30, 0, weekOffset + 1, { includeSamples: false, includeContent: false, compact: true }))
      : selectPipeline(
          service.pipelineOverview(weekOffset + 1, periodDays, 0, undefined, {
            includeSamples: false,
            includeContent: false,
            compact: true,
          }),
        );
  const comparisonX =
    periodDays === 1
      ? selectX(xActivityDashboard(backendDb, (weekOffset + 1) / 30, 30, config.TIMEZONE))
      : selectX(xActivityDashboard(backendDb, weekOffset + 1, periodDays, config.TIMEZONE));

  const [yesterdayStart, yesterdayEnd] = rollingPeriodDates(weekOffset + 1, 1, config.TIMEZONE);
  const previousEnd = periodDays === 1 ? yesterdayEnd : rollingPeriodDates(weekOffset + 1, periodDays, config.TIMEZONE)[1];
  const previousStart =
    periodDays === 1 ? shiftDays(yesterdayEnd, -29) : rollingPeriodDates(weekOffset + 1, periodDays, config.TIMEZONE)[0];
  const videoEnabled = config.studio.modules.video_posting && !activeView;
  const medianOffsetDays = weekOffset * periodDays + periodDays;
  const medianPeriodOffset = medianOffsetDays / 30;
  const [medianStart, medianEnd] = rollingPeriodDates(medianPeriodOffset, 30, config.TIMEZONE);
  const videoHistoryStart = new Date(Math.min(start.getTime(), previousStart.getTime(), medianStart.getTime(), yesterdayStart.getTime()));
  const videoHistoryEnd = new Date(
    Math.max(end.getTime(), previousEnd.getTime(), medianEnd.getTime(), yesterdayEnd.getTime()) + 86_400_000 - 1,
  );
  setVideoOverviewCacheRange(videoCache, videoHistoryStart, videoHistoryEnd, periodDays <= 7 ? 60 * 60 : 24 * 60 * 60);

  return {
    data: selectPipeline(
      service.pipelineOverview(weekOffset, periodDays, 0, undefined, {
        includeSamples: false,
        contentLimit: 4,
        compact: true,
      }),
    ),
    previousData: comparisonPipeline,
    xItems: selectX(xActivityDashboard(backendDb, weekOffset, periodDays, config.TIMEZONE)),
    previousXItems: comparisonX,
    dayComparisonData:
      periodDays === 1
        ? selectPipeline(
            service.pipelineOverview(0, 1, 0, weekOffset + 1, {
              includeSamples: false,
              includeContent: false,
              compact: true,
            }),
          )
        : null,
    video: videoEnabled ? videoForDates(backendDb, config.TIMEZONE, videoCache, start, end, true) : emptyVideoOverview(),
    previousVideo: videoEnabled
      ? videoForDates(backendDb, config.TIMEZONE, videoCache, previousStart, previousEnd, true)
      : emptyVideoOverview(),
    dayComparisonVideo:
      videoEnabled && periodDays === 1 ? videoForDates(backendDb, config.TIMEZONE, videoCache, yesterdayStart, yesterdayEnd, true) : null,
    medianData: selectPipeline(
      service.pipelineOverview(0, 30, 0, medianOffsetDays, { includeSamples: false, includeContent: false, compact: true }),
    ),
    medianXItems: selectX(xActivityDashboard(backendDb, medianPeriodOffset, 30, config.TIMEZONE)),
    medianVideo: videoEnabled ? videoForDates(backendDb, config.TIMEZONE, videoCache, medianStart, medianEnd, true) : emptyVideoOverview(),
    followers: audiencePlatformFollowers(backendDb),
    rangeStart: start,
    rangeEnd: end,
    periodDays,
    weekOffset,
    timeZone: config.TIMEZONE,
    platformMetric,
    textTargetIds: selectedTargetIds,
    textView: activeView,
    publicationDetailsUrl: publicationDetailsUrl(periodDays, weekOffset, activeView, platformMetric),
  };
}

export function videoOverviewForPeriod(backendDb: BackendDb, weekOffset: number, periodDays: number, config: BackendConfig): VideoOverview {
  const [start, end] = rollingPeriodDates(weekOffset, periodDays, config.TIMEZONE);
  return videoForDates(backendDb, config.TIMEZONE, createVideoOverviewCache(periodDays <= 7 ? 60 * 60 : 24 * 60 * 60), start, end, true);
}

function videoForDates(
  backendDb: BackendDb,
  timeZone: string,
  cache: OverviewCache,
  start: Date,
  end: Date,
  endOfDay: boolean,
): VideoOverview {
  return videoOverview(backendDb, videoDayBounds(start, timeZone, false), videoDayBounds(end, timeZone, endOfDay), timeZone, cache);
}

function videoDayBounds(date: Date, timeZone: string, endOfDay: boolean): Date {
  const start = zonedSlot(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), "00:00", timeZone);
  return endOfDay ? new Date(start.getTime() + 86_400_000 - 1) : start;
}

function publicationDetailsUrl(
  periodDays: number,
  weekOffset: number,
  requestedView: AudienceView | undefined,
  platformMetric: PlatformMetric,
): string {
  const params = new URLSearchParams({ period: String(periodDays), week_offset: String(weekOffset) });
  if (requestedView) params.set("view", requestedView);
  if (platformMetric === "followers") params.set("metric", platformMetric);
  return `/api/command-center/publication-details?${params.toString()}`;
}

function shiftDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function filterPipeline(data: PipelineData | null, targetIds: readonly string[]): PipelineData | null {
  if (!data) return null;
  return { ...data, posts: (data.posts ?? []).filter((post) => targetIds.some((target) => postHasTarget(post, target))) };
}

function postHasTarget(post: PipelinePost, target: string): boolean {
  if (post.targets?.[target]?.status === "published") return true;
  if (target === "telegram" && post.telegram_url) return true;
  return Boolean(post.metrics?.[target]);
}
