import { type DailyReach, emptyDailyReach, latestAtOrBefore, type PeriodDay, type ReachSeries } from "./daily-reach.js";

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

/**
 * The video feed's adapter onto the shared reach vocabulary: a like is the video
 * answer to a reaction, a comment to a reply, and there is nothing to repost.
 */
export function videoReachSeries(publishedAt: string | null, target: string, history: readonly VideoSnapshot[]): ReachSeries {
  return {
    publishedAt,
    target,
    samples: history.map((snapshot) => ({
      at: snapshot.at,
      views: snapshot.metrics.views,
      reactions: snapshot.metrics.likes,
      replies: snapshot.metrics.comments,
      reposts: 0,
    })),
  };
}

export function periodMetrics(history: VideoSnapshot[], days: PeriodDay[]): { totals: DailyReach } {
  const totals = emptyDailyReach();
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
