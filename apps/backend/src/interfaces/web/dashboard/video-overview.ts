import type { BackendDb } from "../../../db/client.js";
import { calendarDays, emptyMetrics, latestAtOrBefore, periodMetrics, periodSubscriberDelta } from "./video-overview-calendar.js";
import {
  aggregateDailyMetrics,
  destinationFor,
  destinationKey,
  type VideoOverview,
  type VideoOverviewCache,
  videoAnalyticsBundle,
  videoLabel,
  videoSummaryMetrics,
  viewEvents,
} from "./video-overview-data.js";

export type { VideoContentItem, VideoOverview, VideoOverviewCache } from "./video-overview-data.js";

export {
  createVideoOverviewCache,
  emptyVideoOverview,
  invalidateVideoOverviewCache,
  setVideoOverviewCacheRange,
} from "./video-overview-data.js";

/**
 * Public facade for the dashboard video read model.
 *
 * Querying, aggregation and cache state live in video-overview-data.ts. This
 * module assembles the stable overview shape consumed by dashboard renderers.
 */
export function videoOverview(
  backendDb: BackendDb,
  start: Date,
  end: Date,
  timeZone = "Europe/Moscow",
  cache?: VideoOverviewCache,
): VideoOverview {
  const bundle = videoAnalyticsBundle(backendDb, start, end, cache);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const rows = bundle.rows.filter((row) => Boolean(row.publishedAt && row.publishedAt >= startIso && row.publishedAt <= endIso));
  const snapshots = new Map(rows.map((row) => [row.id, bundle.snapshots.get(row.id) ?? []]));
  const periodDays = calendarDays(start, end, timeZone);
  const summary = videoSummaryMetrics(backendDb, rows, snapshots, periodDays, end, timeZone, cache);
  const items = rows
    .map((row) => {
      const history = snapshots.get(row.id) ?? [];
      const period = periodMetrics(history, periodDays);
      const periodEnd = latestAtOrBefore(history, end)?.metrics ?? emptyMetrics();
      const lifetime = history.at(-1)?.metrics ?? emptyMetrics();
      const destination = destinationFor(bundle.catalogue, row);
      return {
        key: `video:${row.id}`,
        target: row.target,
        providerAccountId: row.providerAccountId,
        label: destination?.label ?? videoLabel(row.target),
        locale: destination ? destination.locale.toUpperCase() : (row.locale?.toUpperCase() ?? null),
        title: row.label || "Без названия",
        url: row.externalUrl,
        publishedAt: row.publishedAt,
        views: period.totals.views,
        reactions: period.totals.reactions,
        replies: period.totals.replies,
        afterPeriodViews: Math.max(0, lifetime.views - periodEnd.views),
        lifetimeViews: lifetime.views,
        subscribers: periodSubscriberDelta(history, periodDays),
      };
    })
    .sort((left, right) => (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""));

  const totals = items.reduce(
    (all, item) => {
      all.views += item.views;
      all.reactions += item.reactions;
      all.replies += item.replies;
      all.posts += 1;
      return all;
    },
    { views: 0, reactions: 0, replies: 0, posts: 0 },
  );

  // One row per declared destination, filtered to the ones this Studio actually
  // has: publications in the period, or an audience snapshot. Listing the whole
  // catalogue would put an English channel on a Studio that has never had one;
  // listing only what published would drop a real channel on a quiet week.
  const counted = bundle.catalogue.map((destination) => {
    const published = items.filter((item) => item.target === destination.target && item.locale === destination.locale.toUpperCase());
    return {
      destination,
      published,
      hasPublication: bundle.historicalDestinations.has(destinationKey(destination)),
      own: bundle.followers.get(destination.profile) ?? null,
    };
  });
  const platforms = counted
    .map(({ destination, published, hasPublication, own }) => ({
      target: destination.target as string,
      label: destination.label,
      locales: [destination.locale.toUpperCase()],
      views: published.reduce((sum, item) => sum + item.views, 0),
      followers: own,
      active: hasPublication || own !== null,
    }))
    .filter((row) => row.active)
    .map(({ active: _active, ...row }) => row);

  return {
    items,
    totals,
    summary,
    platforms,
    dailyByDay: aggregateDailyMetrics(backendDb, rows, snapshots, periodDays, cache),
    viewEvents: viewEvents(rows, snapshots, start, end),
  };
}
