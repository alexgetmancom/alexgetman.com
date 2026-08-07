import { zonedDateParts, zonedSlot } from "../../../foundation/time.js";

/**
 * One vocabulary for "what did a day earn", shared by both halves of the
 * overview.
 *
 * Text, video and X all store the same thing: a cumulative counter per
 * publication, sampled over time. What differs is only where the samples come
 * from — `metric_samples`, `video_metric_snapshots`, `x_activity_metric_snapshots`.
 * Each feed adapts its rows into `ReachSeries` and everything downstream — the
 * daily bars, the hero figure, the norm, the platform split — is computed here,
 * once, identically.
 *
 * The rule that makes the numbers comparable: a day is credited with the views
 * that arrived *on that day*, never with the lifetime of what was published on
 * it. A clip's later growth belongs to the days it actually happened, so the
 * bars of one chart can be summed, compared, and averaged.
 */

export type ReachCounters = { views: number; reactions: number; replies: number; reposts: number };
export type ReachSample = { at: Date } & ReachCounters;

/** One publication on one destination: when it went out, and how it grew. */
export type ReachSeries = { publishedAt: string | null; target: string; samples: ReachSample[] };

/** A day's earnings, plus the share of them produced by that day's own output. */
export type DailyReach = ReachCounters & { freshViews: number };

export type PeriodDay = { key: string; start: Date; end: Date };

export function emptyReachCounters(): ReachCounters {
  return { views: 0, reactions: 0, replies: 0, reposts: 0 };
}

export function emptyDailyReach(): DailyReach {
  return { ...emptyReachCounters(), freshViews: 0 };
}

export function latestAtOrBefore<T extends { at: Date }>(samples: readonly T[], cutoff: Date): T | undefined {
  let low = 0;
  let high = samples.length - 1;
  let latest: T | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const sample = samples[middle];
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

/** Daily increments for every series, split into the day's own output and its back catalogue. */
export function dailyReach(series: readonly ReachSeries[], days: readonly PeriodDay[], timeZone: string): Record<string, DailyReach> {
  const result: Record<string, DailyReach> = {};
  for (const day of days) result[day.key] = emptyDailyReach();
  for (const entry of series) {
    const publishedKey = publicationDayKey(entry, timeZone);
    for (const day of days) {
      const before = baselineAt(entry, day.start);
      const atEnd = latestAtOrBefore(entry.samples, day.end) ?? before;
      const bucket = result[day.key] ?? emptyDailyReach();
      const gained = Math.max(0, (atEnd?.views ?? 0) - (before?.views ?? 0));
      bucket.views += gained;
      if (publishedKey === day.key) bucket.freshViews += gained;
      bucket.reactions += Math.max(0, (atEnd?.reactions ?? 0) - (before?.reactions ?? 0));
      bucket.replies += Math.max(0, (atEnd?.replies ?? 0) - (before?.replies ?? 0));
      bucket.reposts += Math.max(0, (atEnd?.reposts ?? 0) - (before?.reposts ?? 0));
      result[day.key] = bucket;
    }
  }
  return result;
}

/**
 * The counter's value when the day opened.
 *
 * A publication older than the window has no sample inside it to start from, and
 * treating that as zero would dump its whole lifetime onto the first bar. Its
 * earliest sample in the window is the honest baseline: everything before it was
 * earned before we were looking. A publication from inside the window really did
 * start at zero.
 */
function baselineAt(entry: ReachSeries, dayStart: Date): ReachSample | undefined {
  const published = entry.publishedAt ? new Date(entry.publishedAt) : null;
  // Born inside this day, so it opened at zero — even when its first reading
  // lands exactly on the day boundary.
  if (published && !Number.isNaN(published.getTime()) && published >= dayStart) return undefined;
  return latestAtOrBefore(entry.samples, dayStart) ?? entry.samples[0];
}

function publicationDayKey(entry: ReachSeries, timeZone: string): string | null {
  if (!entry.publishedAt) return null;
  const published = new Date(entry.publishedAt);
  return Number.isNaN(published.getTime()) ? null : calendarKey(published, timeZone);
}
