import type { BackendDb } from "../../../db/client.js";
import { zonedRollingPeriodBounds } from "../../../foundation/time.js";
import type { createOperationsService } from "../../../operations/service.js";
import { ORDERED_TARGETS } from "./assets.js";
import { calendarDays, type DailyReach, dailyReach, emptyDailyReach, type PeriodDay } from "./daily-reach.js";
import { textReachSeries, type XActivitySeries, xActivityReachSeries } from "./text-reach.js";
import type { PipelinePost } from "./types.js";

/**
 * Read model behind the text half of the unified overview — the twin of
 * videoOverview's reach half, and deliberately the same shape.
 *
 * It answers "what did text earn on each day", per destination, over one window
 * wide enough to cover the chart, the period, its comparison and the norm. That
 * window is what makes the numbers agree: a post published three weeks ago is
 * still earning views today, and it can only be counted on today's bar if it is
 * loaded when today is drawn.
 */

export type TextOverview = {
  /** Every destination's daily reach, keyed by target then by calendar date. */
  byTarget: Record<string, Record<string, DailyReach>>;
  days: PeriodDay[];
};

type OverviewService = ReturnType<typeof createOperationsService>;

/** The chart needs thirty days of context on top of whatever period is selected. */
const HISTORY_CONTEXT_DAYS = 30;

export function emptyTextOverview(): TextOverview {
  return { byTarget: {}, days: [] };
}

export function textOverview(
  backendDb: BackendDb,
  service: OverviewService,
  weekOffset: number,
  periodDays: number,
  timeZone: string,
): TextOverview {
  const historyDays = periodDays + HISTORY_CONTEXT_DAYS;
  const offsetDays = weekOffset * periodDays;
  const posts = (service.pipelineOverview(0, historyDays, 0, offsetDays, {
    includeSamples: true,
    includeContent: false,
    compact: true,
  }).posts ?? []) as PipelinePost[];
  const [startIso, endIso] = zonedRollingPeriodBounds(offsetDays / historyDays, historyDays, timeZone);
  const days = calendarDays(new Date(startIso), new Date(endIso), timeZone);

  return textOverviewOf(posts, xActivityReachSeries(backendDb, new Date(startIso), new Date(endIso)), days, timeZone);
}

/** The read model proper, once the rows have been fetched. */
export function textOverviewOf(
  posts: readonly PipelinePost[],
  xSeries: readonly XActivitySeries[],
  days: PeriodDay[],
  timeZone: string,
): TextOverview {
  const covered = new Set(xSeries.map((entry) => entry.linkedPostKey).filter((key): key is string => Boolean(key)));
  const series = [
    ...textReachSeries(
      posts,
      ORDERED_TARGETS.map((target) => target.id),
      covered,
    ),
    ...xSeries,
  ];
  const byTarget: Record<string, Record<string, DailyReach>> = {};
  for (const target of new Set(series.map((entry) => entry.target))) {
    byTarget[target] = dailyReach(
      series.filter((entry) => entry.target === target),
      days,
      timeZone,
    );
  }
  return { byTarget, days };
}

/** Daily totals across the selected destinations, summed from the per-target maps. */
export function textDailyReach(overview: TextOverview, targetIds: readonly string[]): Record<string, DailyReach> {
  const daily: Record<string, DailyReach> = {};
  for (const target of targetIds) {
    for (const [day, values] of Object.entries(overview.byTarget[target] ?? {})) {
      const bucket = daily[day] ?? emptyDailyReach();
      bucket.views += values.views;
      bucket.freshViews += values.freshViews;
      bucket.reactions += values.reactions;
      bucket.replies += values.replies;
      bucket.reposts += values.reposts;
      daily[day] = bucket;
    }
  }
  return daily;
}
