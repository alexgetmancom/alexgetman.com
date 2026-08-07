import { zonedDateParts, zonedSlot } from "../../../foundation/time.js";

export type VideoMetrics = {
  views: number;
  likes: number;
  comments: number;
  averageWatchTimeMs: number | null;
  totalWatchTimeMs: number | null;
  follows: number | null;
  completionRate: number | null;
  videoDurationMs: number | null;
};
export type VideoSnapshot = { at: Date; metrics: VideoMetrics };

export type DailyMetrics = { views: number; reactions: number; replies: number };
export type PeriodDay = { key: string; start: Date; end: Date };

export function latestAtOrBefore(history: VideoSnapshot[], cutoff: Date): VideoSnapshot | undefined {
  let low = 0;
  let high = history.length - 1;
  let latest: VideoSnapshot | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const sample = history[middle];
    if (!sample) break;
    if (sample.at <= cutoff) {
      latest = sample;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return latest;
}

export function calendarDays(start: Date, end: Date, timeZone: string): PeriodDay[] {
  if (end < start) return [];
  const days: PeriodDay[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const parts = zonedDateParts(cursor, timeZone);
    const nextDay = zonedSlot(parts.year, parts.month, parts.day + 1, "00:00", timeZone);
    const dayEnd = new Date(Math.min(end.getTime(), nextDay.getTime() - 1));
    days.push({ key: calendarKey(cursor, timeZone), start: new Date(cursor), end: dayEnd });
    if (dayEnd >= end) break;
    cursor = nextDay;
  }
  return days;
}

export function calendarKey(value: Date, timeZone: string): string {
  const parts = zonedDateParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function emptyMetrics(): VideoMetrics {
  return {
    views: 0,
    likes: 0,
    comments: 0,
    averageWatchTimeMs: null,
    totalWatchTimeMs: null,
    follows: null,
    completionRate: null,
    videoDurationMs: null,
  };
}

export function emptyDailyMetrics(): DailyMetrics {
  return { views: 0, reactions: 0, replies: 0 };
}

export function periodMetrics(history: VideoSnapshot[], days: PeriodDay[]): { totals: DailyMetrics } {
  const totals = emptyDailyMetrics();
  for (const day of days) {
    const before = latestAtOrBefore(history, day.start)?.metrics ?? emptyMetrics();
    const atEnd = latestAtOrBefore(history, day.end)?.metrics ?? before;
    totals.views += Math.max(0, atEnd.views - before.views);
    totals.reactions += Math.max(0, atEnd.likes - before.likes);
    totals.replies += Math.max(0, atEnd.comments - before.comments);
  }
  return { totals };
}

export function periodSubscriberDelta(history: VideoSnapshot[], days: PeriodDay[]): number | null {
  let total = 0;
  let observed = false;
  for (const day of days) {
    const before = latestAtOrBefore(history, day.start)?.metrics ?? emptyMetrics();
    const atEnd = latestAtOrBefore(history, day.end)?.metrics ?? before;
    if (before.follows === null && atEnd.follows === null) continue;
    observed = true;
    total += (atEnd.follows ?? before.follows ?? 0) - (before.follows ?? 0);
  }
  return observed ? total : null;
}
