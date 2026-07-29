import { openBackendDb } from "../../../backend/src/db/client.js";
import {
  metricSamples,
  metricSchedule,
  postMetrics,
  postTargets,
  publishJobs,
  siteJobs,
  workerState,
  xActivityItems,
  xActivityMetricSnapshots,
} from "../../../backend/src/db/schema.js";

/**
 * Adds the operational layer on top of a database already seeded by
 * site-fixture.ts, so /command-center renders a populated dashboard locally
 * instead of a screen of zeroes.
 *
 * The two fixtures are deliberately separate: site-fixture writes what the
 * public read model needs (publications, posts, locales, media on disk), this
 * one writes what only Command Center reads (per-target publish state, metric
 * history, queue and worker rows). A site-only seed stays cheap, and a
 * dashboard seed cannot drift into inventing posts of its own.
 *
 * What the shape is chosen to exercise, because none of it is visible on an
 * all-green fixture:
 *   - a failed target with an error, so the danger styling and the audit path
 *     have something to show;
 *   - a queued job and a retrying job, so the queue panel is not empty;
 *   - several days of metric samples, so the chart draws a line rather than a
 *     single point, and today vs. yesterday differ;
 *   - two locales' site targets, so the per-target columns are not identical.
 */

/** Targets seeded per post, with the status the dashboard should display. */
const TARGET_PLAN = [
  { target: "telegram", status: "published", views: 4100, likes: 210 },
  { target: "site_ru", status: "published", views: 980, likes: 24 },
  { target: "site_en", status: "published", views: 1240, likes: 31 },
  { target: "threads_en", status: "published", views: 420, likes: 12 },
  { target: "x", status: "failed", views: 0, likes: 0, error: "X API 401: token expired" },
] as const;

const DAYS_OF_HISTORY = 14;
/** Two-hourly samples: enough to draw a readable curve, few enough to seed fast. */
const HOURS_PER_SAMPLE = 2;
const SAMPLES_PER_DAY = 24 / HOURS_PER_SAMPLE;

const iso = (date: Date): string => date.toISOString();

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);

const daysAgo = (days: number): Date => hoursAgo(days * 24);

export type SeededDashboard = {
  targetRows: number;
  sampleRows: number;
};

export function seedDashboardFixture(options: { dbPath: string; postIds: number[] }): SeededDashboard {
  const backendDb = openBackendDb(options.dbPath);
  const now = new Date();
  const nowIso = iso(now);
  let targetRows = 0;
  let sampleRows = 0;

  try {
    for (const [index, postId] of options.postIds.entries()) {
      const postKey = `post:${postId}`;
      // Spread the posts across recent days so the period filters (day, week,
      // month) each select a different slice instead of all showing everything.
      const publishedAt = iso(daysAgo(index));

      for (const plan of TARGET_PLAN) {
        const failed = plan.status === "failed";
        backendDb.db
          .insert(postTargets)
          .values({
            postKey,
            target: plan.target,
            status: plan.status,
            externalId: failed ? null : `${plan.target}-${postId}`,
            url: failed ? null : `https://example.com/${plan.target}/${postId}`,
            error: failed ? (plan.error ?? null) : null,
            skipped: 0,
            publishedAt: failed ? null : publishedAt,
            updatedAt: nowIso,
          })
          .run();
        targetRows += 1;

        if (failed) continue;

        // Later posts are younger, so scale their totals down: a flat number
        // across every post makes the "best posts" ranking meaningless.
        const decay = 1 - index * 0.18;
        for (const [metricName, base] of [
          ["views", plan.views],
          ["likes", plan.likes],
        ] as const) {
          const value = Math.max(0, Math.round(base * decay));
          backendDb.db
            .insert(postMetrics)
            .values({ postKey, target: plan.target, metricName, value, unit: "count", source: "fixture", sampledAt: nowIso })
            .run();

          // A growth curve rather than noise: the chart is read for shape, and
          // random values make a regression in the drawing code invisible.
          //
          // Samples are spread across the hours of each day, not written once
          // per day at whatever time the seed ran. The overview chart plots
          // today against yesterday by time of day; with a single timestamp per
          // day every point lands on one x and the line renders as a vertical
          // spike instead of a curve.
          const slots = DAYS_OF_HISTORY * SAMPLES_PER_DAY;
          for (let slot = slots; slot >= 0; slot -= 1) {
            const progress = (slots - slot) / slots;
            backendDb.db
              .insert(metricSamples)
              .values({
                postKey,
                target: plan.target,
                metricName,
                value: Math.round(value * progress),
                sampledAt: iso(hoursAgo(slot * HOURS_PER_SAMPLE)),
                source: "fixture",
              })
              .run();
            sampleRows += 1;
          }
        }

        backendDb.db
          .insert(metricSchedule)
          .values({
            postKey,
            target: plan.target,
            nextCheckAt: iso(daysAgo(-1)),
            lastCheckedAt: nowIso,
            checkCount: 12,
            updatedAt: nowIso,
          })
          .run();
      }

      backendDb.db
        .insert(publishJobs)
        .values({
          postId,
          postKey,
          messageId: postId,
          target: "x",
          status: index === 0 ? "failed" : "done",
          publishAt: publishedAt,
          lastError: index === 0 ? "X API 401: token expired" : null,
          attemptCount: index === 0 ? 3 : 1,
          createdAt: publishedAt,
          updatedAt: nowIso,
        })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({
          postId,
          messageId: postId,
          reason: "publish",
          status: "done",
          attemptCount: 1,
          createdAt: publishedAt,
          updatedAt: nowIso,
        })
        .run();
    }

    // One job left in the queue, so the queue panel and the "in flight" counter
    // are exercised. It has no post of its own on purpose: the dashboard must
    // survive a job whose post row is not there yet.
    backendDb.db
      .insert(publishJobs)
      .values({
        postId: 999,
        postKey: "post:999",
        messageId: 999,
        target: "telegram",
        status: "queued",
        publishAt: iso(daysAgo(-1)),
        attemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .run();

    backendDb.db
      .insert(workerState)
      .values({ name: "publisher", stateJson: { lastRunAt: nowIso, status: "idle" }, updatedAt: nowIso })
      .run();
    backendDb.db
      .insert(workerState)
      .values({ name: "metrics", stateJson: { lastRunAt: nowIso, status: "idle" }, updatedAt: nowIso })
      .run();

    for (let index = 0; index < 8; index += 1) {
      const xPostId = `fixture-x-${index + 1}`;
      const reply = index % 3 === 1;
      const publishedAt = iso(hoursAgo(index * 8));
      backendDb.db
        .insert(xActivityItems)
        .values({
          xPostId,
          kind: reply ? "reply" : "standalone",
          publishedAt,
          text: reply ? `@researcher Fixture reply number ${index + 1}` : `Fixture X publication number ${index + 1}`,
          url: `https://x.com/alexgetmancom/status/${xPostId}`,
          linkedPostKey: !reply && options.postIds[index] ? `post:${options.postIds[index]}` : null,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          rawJson: { source: "fixture" },
        })
        .run();
      for (const [metricName, value] of [
        ["views", 5_000 - index * 430],
        ["interactions", 120 - index * 8],
        ["replies", reply ? 18 - index : 4 + index],
      ] as const)
        backendDb.db
          .insert(xActivityMetricSnapshots)
          .values({ xPostId, metricName, value, sampledAt: nowIso, rawJson: { source: "fixture" } })
          .run();
    }
  } finally {
    backendDb.close();
  }

  return { targetRows, sampleRows };
}
