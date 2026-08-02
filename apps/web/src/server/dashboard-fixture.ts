import { openBackendDb } from "../../../backend/src/db/client.js";
import {
  creatorProfileSnapshots,
  metricSamples,
  metricSchedule,
  postMetrics,
  postTargets,
  publishJobs,
  siteJobs,
  videoDrafts,
  videoMetricSnapshots,
  videoTargets,
  workerState,
  xActivityItems,
  xActivityMetricSnapshots,
} from "../../../backend/src/db/schema.js";
import { PARITY_HISTORY_DAYS } from "./site-fixture.js";

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

/**
 * Clips for the video half of the unified overview. Deliberately lopsided
 * against the text plan above: video reach is an order of magnitude larger than
 * text reach in production, and a fixture where the two are comparable hides
 * the whole reason the overview chart carries a scale toggle.
 *
 * The locales are mixed on purpose. The overview reads a video platform's
 * language off the drafts published there, so a single-locale fixture would
 * make the badges look hardcoded and hide the bilingual case entirely.
 */
const VIDEO_PLAN = [
  {
    label: "ByteDance выпустила Seedance 2.5",
    locale: "ru",
    hoursAgo: 6,
    targets: [{ target: "youtube_shorts", views: 46_800, likes: 2_010, comments: 180 }],
  },
  {
    label: "Seedance 2.5 is AGI for video",
    locale: "en",
    hoursAgo: 20,
    targets: [{ target: "instagram_reels", views: 31_700, likes: 1_240, comments: 96 }],
  },
  {
    label: "Gemini 3.5 Pro на Arena",
    locale: "ru",
    hoursAgo: 34,
    targets: [
      { target: "youtube_shorts", views: 20_200, likes: 780, comments: 41 },
      { target: "instagram_reels", views: 9_400, likes: 310, comments: 18 },
    ],
  },
] as const;

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
    for (const [index, plan] of VIDEO_PLAN.entries()) {
      const publishedAt = iso(hoursAgo(plan.hoursAgo));
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 1,
          locale: plan.locale,
          label: plan.label,
          assetKey: `fixture-video-${index + 1}`,
          status: "published",
          scheduledAt: publishedAt,
          createdAt: publishedAt,
          updatedAt: nowIso,
        })
        .returning({ id: videoDrafts.id })
        .get();

      for (const target of plan.targets) {
        const inserted = backendDb.db
          .insert(videoTargets)
          .values({
            videoDraftId: draft.id,
            target: target.target,
            metadataJson: { title: plan.label, description: "fixture", tags: [] },
            status: "published",
            scheduledAt: publishedAt,
            publishedAt,
            externalId: `${target.target}-${draft.id}`,
            externalUrl: `https://example.com/${target.target}/${draft.id}`,
            createdAt: publishedAt,
            updatedAt: nowIso,
          })
          .returning({ id: videoTargets.id })
          .get();
        targetRows += 1;

        // Same two-hourly cadence as the text samples, so both lines on the
        // overview chart are drawn from observations on the same clock.
        const slots = Math.max(1, Math.round(plan.hoursAgo / HOURS_PER_SAMPLE));
        for (let slot = slots; slot >= 0; slot -= 1) {
          const progress = (slots - slot) / slots;
          backendDb.db
            .insert(videoMetricSnapshots)
            .values({
              videoTargetId: inserted.id,
              platform: target.target,
              metricsJson: {
                views: Math.round(target.views * progress),
                likes: Math.round(target.likes * progress),
                comments: Math.round(target.comments * progress),
              },
              sampledAt: iso(hoursAgo(slot * HOURS_PER_SAMPLE)),
            })
            .run();
          sampleRows += 1;
        }
      }
    }

    // Follower counts for the video column of the platforms panel, keyed per
    // destination the way production has recorded them since the RU/EN channels
    // were split. The text platforms read theirs from creator_profiles, which
    // site-fixture seeds.
    for (const [platform, followers] of [
      ["youtube_ru", 8_400],
      ["youtube_en", 1_260],
      ["instagram_ru", 5_120],
      ["instagram_en", 940],
    ] as const)
      backendDb.db
        .insert(creatorProfileSnapshots)
        .values({
          platform,
          account: "alexgetman",
          sampledOn: nowIso.slice(0, 10),
          metricsJson: { subscriberCount: followers },
          source: "fixture",
          sampledAt: nowIso,
        })
        .run();
  } finally {
    backendDb.close();
  }

  return { targetRows, sampleRows };
}

/* ------------------------------------------------------------------------- *
 * Reference-layout parity fixture
 *
 * Seeds the exact numbers of the overview reference layout so the two can be
 * compared side by side. Reconciled from the publication list rather than from
 * its platform panel: the reference assigns 4128 views two different ways
 * (posts give Telegram 2868 / X 1114 / Threads 146, the panel next to it says
 * Telegram 2480 / X 1502 / Threads 146). Only one of those can be true of real
 * rows, and the publication list is the one whose per-post numbers are visible.
 *
 * "X RU" and "X EN" cannot both exist here — `x` is a single target with a
 * single locale — so the reference's second X row is seeded as Threads RU. The
 * RU/EN split still lands exactly on its 86% / 14% · 558.
 * ------------------------------------------------------------------------- */

/** One primary target per publication, matching the reference list top to bottom. */
const PARITY_POSTS = [
  { target: "telegram", views: 1_420, likes: 55, reposts: 9, replies: 9 },
  { target: "telegram", views: 1_060, likes: 41, reposts: 0, replies: 7 },
  { target: "threads_ru", views: 702, likes: 22, reposts: 0, replies: 4 },
  { target: "x", views: 412, likes: 14, reposts: 0, replies: 2 },
  { target: "telegram", views: 388, likes: 6, reposts: 0, replies: 1 },
  { target: "threads_en", views: 146, likes: 5, reposts: 0, replies: 0 },
] as const;

/** Median daily reach the archived history is built around — the "норма дня"
 * the hero card reports is the median of these days, not any single one of
 * them, so the days themselves have to vary or the sparkline draws a flat
 * line and the norm stops looking like a norm. */
const PARITY_DAILY_TEXT_VIEWS = 3_600;
const PARITY_DAILY_VIDEO_VIEWS = 12_000;

/**
 * A day-by-day multiplier series with a median of exactly 1 by construction:
 * fifteen values below 1, fifteen at-or-above it, so `PARITY_DAILY_*_VIEWS *
 * series[i]` reproduces the stated median precisely while every individual day
 * still differs. Order (not just the multiset) matters here — this is read
 * day-by-day into the sparkline — so the values are shuffled by a small
 * deterministic generator rather than left sorted, which would draw a ramp.
 */
function dailyVarianceSeries(days: number, seed: number): number[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
  const below = Array.from({ length: Math.ceil(days / 2) }, () => 0.35 + next() * 0.6);
  const above = Array.from({ length: Math.floor(days / 2) }, () => 1 + next() * 1.4);
  const series = [...below, ...above];
  for (let i = series.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [series[i], series[j]] = [series[j] as number, series[i] as number];
  }
  return series;
}

/** Clips as the reference lists them: three bilingual drafts on two platforms
 * each, plus one EN clip per platform, so all four video rows carry a figure. */
const PARITY_VIDEO = [
  {
    label: "ТРЕНЕР НЕ УЗНАЕТ! 🤫 выпустили чела без трусов | Kitman",
    locale: "ru",
    hoursAgo: 5,
    targets: [
      { target: "instagram_reels", views: 4_400, likes: 57, comments: 0 },
      { target: "youtube_shorts", views: 822, likes: 16, comments: 1 },
    ],
  },
  {
    label: "ШКАФ УБИЛ ДРУГА?! 💀 | Call it a Day",
    locale: "ru",
    hoursAgo: 9,
    targets: [
      { target: "instagram_reels", views: 2_000, likes: 30, comments: 0 },
      { target: "youtube_shorts", views: 899, likes: 22, comments: 0 },
    ],
  },
  {
    label: "МЕНЯ СДЕЛАЛИ КЛОУНОМ! 🤡 Самый честный обзор",
    locale: "ru",
    hoursAgo: 13,
    targets: [
      { target: "instagram_reels", views: 887, likes: 11, comments: 1 },
      { target: "youtube_shorts", views: 10, likes: 4, comments: 0 },
    ],
  },
  {
    label: "BEHIND THE SCENES | day 4",
    locale: "en",
    hoursAgo: 17,
    targets: [{ target: "youtube_shorts", views: 367, likes: 6, comments: 0 }],
  },
  {
    label: "we broke the closet | shorts",
    locale: "en",
    hoursAgo: 21,
    targets: [{ target: "instagram_reels", views: 212, likes: 4, comments: 0 }],
  },
] as const;

/** Average watch time the reference reports, applied to every clip. */
const PARITY_WATCH_TIME_MS = 13_000;

/**
 * Seeds the parity dataset over a database already carrying
 * `overviewParityFixture()` posts. Kept separate from seedDashboardFixture:
 * that one is the everyday dev fixture and is deliberately not all-green, this
 * one exists to be held next to the reference layout.
 */
export function seedOverviewParityFixture(options: { dbPath: string; postIds: number[] }): SeededDashboard {
  const backendDb = openBackendDb(options.dbPath);
  const now = new Date();
  const nowIso = iso(now);
  let targetRows = 0;
  let sampleRows = 0;

  const writeMetric = (postKey: string, target: string, metricName: string, value: number, sampledAt: string) => {
    backendDb.db.insert(postMetrics).values({ postKey, target, metricName, value, unit: "count", source: "fixture", sampledAt }).run();
  };
  const publishTarget = (postKey: string, target: string, publishedAt: string) => {
    backendDb.db
      .insert(postTargets)
      .values({
        postKey,
        target,
        status: "published",
        externalId: `${target}-${postKey}`,
        url: `https://example.com/${target}/${postKey}`,
        skipped: 0,
        publishedAt,
        updatedAt: nowIso,
      })
      .run();
    targetRows += 1;
  };

  try {
    const todayIds = options.postIds.slice(0, PARITY_POSTS.length);
    const historyIds = options.postIds.slice(PARITY_POSTS.length);

    for (const [index, plan] of PARITY_POSTS.entries()) {
      const postId = todayIds[index];
      if (postId === undefined) break;
      const postKey = `post:${postId}`;
      // Spread across the day so the daily chart draws a curve rather than a
      // single column, but all inside today's window.
      const publishedAt = iso(hoursAgo(3 + index * 2));
      publishTarget(postKey, plan.target, publishedAt);
      for (const [metricName, value] of [
        ["views", plan.views],
        ["likes", plan.likes],
        ["reposts", plan.reposts],
        ["replies", plan.replies],
      ] as const)
        writeMetric(postKey, plan.target, metricName, value, nowIso);

      const slots = Math.max(1, Math.round((3 + index * 2) / HOURS_PER_SAMPLE));
      for (let slot = slots; slot >= 0; slot -= 1) {
        backendDb.db
          .insert(metricSamples)
          .values({
            postKey,
            target: plan.target,
            metricName: "views",
            value: Math.round(plan.views * ((slots - slot) / slots)),
            sampledAt: iso(hoursAgo(slot * HOURS_PER_SAMPLE)),
            source: "fixture",
          })
          .run();
        sampleRows += 1;
      }
    }

    // Quiet history: one publication per past day carrying that day's whole
    // reach, so the sparkline has thirty different bars to draw and the norm is
    // their median rather than any single day's number.
    const textVariance = dailyVarianceSeries(historyIds.length, 11);
    for (const [index, postId] of historyIds.entries()) {
      const day = daysAgo(index + 1);
      const dayIso = iso(day);
      const postKey = `post:${postId}`;
      const factor = textVariance[index] ?? 1;
      publishTarget(postKey, "telegram", dayIso);
      for (const [metricName, base] of [
        ["views", PARITY_DAILY_TEXT_VIEWS],
        ["likes", 120],
        ["replies", 18],
      ] as const)
        writeMetric(postKey, "telegram", metricName, Math.round(base * factor), dayIso);
    }

    backendDb.db
      .insert(workerState)
      .values({ name: "publisher", stateJson: { lastRunAt: nowIso, status: "idle" }, updatedAt: nowIso })
      .run();
    backendDb.db
      .insert(workerState)
      .values({ name: "metrics", stateJson: { lastRunAt: nowIso, status: "idle" }, updatedAt: nowIso })
      .run();

    for (const [index, plan] of PARITY_VIDEO.entries()) {
      const publishedAt = iso(hoursAgo(plan.hoursAgo));
      const draft = backendDb.db
        .insert(videoDrafts)
        .values({
          actorId: 1,
          locale: plan.locale,
          label: plan.label,
          assetKey: `parity-video-${index + 1}`,
          status: "published",
          scheduledAt: publishedAt,
          createdAt: publishedAt,
          updatedAt: nowIso,
        })
        .returning({ id: videoDrafts.id })
        .get();

      for (const target of plan.targets) {
        const inserted = backendDb.db
          .insert(videoTargets)
          .values({
            videoDraftId: draft.id,
            target: target.target,
            metadataJson: { title: plan.label, description: "fixture", tags: [], videoDurationMs: 24_000 },
            status: "published",
            scheduledAt: publishedAt,
            publishedAt,
            externalId: `${target.target}-${draft.id}`,
            externalUrl: `https://example.com/${target.target}/${draft.id}`,
            createdAt: publishedAt,
            updatedAt: nowIso,
          })
          .returning({ id: videoTargets.id })
          .get();
        targetRows += 1;

        const slots = Math.max(1, Math.round(plan.hoursAgo / HOURS_PER_SAMPLE));
        for (let slot = slots; slot >= 0; slot -= 1) {
          const progress = (slots - slot) / slots;
          const views = Math.round(target.views * progress);
          backendDb.db
            .insert(videoMetricSnapshots)
            .values({
              videoTargetId: inserted.id,
              platform: target.target,
              // averageWatchTimeMs directly, not totalWatchTimeMs: the summary
              // derives completion rate from total watch time divided by views
              // times duration, which is a percentage a handful of round input
              // numbers cannot also land on a round output — it was rendering as
              // a seven-digit float. The reference does not show a completion
              // figure at all, so leaving it unset is the accurate match, not a
              // shortcut.
              metricsJson: {
                views,
                likes: Math.round(target.likes * progress),
                comments: Math.round(target.comments * progress),
                averageWatchTimeMs: PARITY_WATCH_TIME_MS,
              },
              sampledAt: iso(hoursAgo(slot * HOURS_PER_SAMPLE)),
            })
            .run();
          sampleRows += 1;
        }
      }
    }

    // One archived clip carries the whole video history: the overview reads a
    // day's reach as the growth between two snapshots, so a single target whose
    // counter climbs by the same amount every day gives a flat, checkable norm.
    // It stops at yesterday, so none of it lands in today's total — and it is
    // published inside the 30-day median window, not before it: the daily chart
    // only ever looks at rows whose publish date falls inside the window it was
    // asked for, so a video published on day 31 contributes to none of it, no
    // matter how many older snapshots it carries.
    const historyPublishedAt = daysAgo(PARITY_HISTORY_DAYS - 1);
    const historyDraft = backendDb.db
      .insert(videoDrafts)
      .values({
        actorId: 1,
        locale: "ru",
        label: "Архивный ролик",
        assetKey: "parity-video-history",
        status: "published",
        scheduledAt: iso(historyPublishedAt),
        createdAt: iso(historyPublishedAt),
        updatedAt: nowIso,
      })
      .returning({ id: videoDrafts.id })
      .get();
    const historyTarget = backendDb.db
      .insert(videoTargets)
      .values({
        videoDraftId: historyDraft.id,
        target: "instagram_reels",
        metadataJson: { title: "Архивный ролик", description: "fixture", tags: [] },
        status: "published",
        publishedAt: iso(historyPublishedAt),
        createdAt: iso(historyPublishedAt),
        updatedAt: nowIso,
      })
      .returning({ id: videoTargets.id })
      .get();
    targetRows += 1;
    // The counter is cumulative, so a varying day-by-day *increment* still has
    // to be summed forward into a monotonic running total — the snapshot at
    // each point is "everything so far", not that day's number on its own.
    const videoVariance = dailyVarianceSeries(PARITY_HISTORY_DAYS - 1, 29);
    let cumulativeViews = 0;
    let cumulativeLikes = 0;
    let cumulativeComments = 0;
    for (let day = PARITY_HISTORY_DAYS - 1; day >= 1; day -= 1) {
      const step = PARITY_HISTORY_DAYS - day; // 1, 2, 3, … — one increment per day
      const factor = videoVariance[step - 1] ?? 1;
      cumulativeViews += Math.round(PARITY_DAILY_VIDEO_VIEWS * factor);
      cumulativeLikes += Math.round(120 * factor);
      cumulativeComments += Math.round(4 * factor);
      backendDb.db
        .insert(videoMetricSnapshots)
        .values({
          videoTargetId: historyTarget.id,
          platform: "instagram_reels",
          metricsJson: { views: cumulativeViews, likes: cumulativeLikes, comments: cumulativeComments },
          sampledAt: iso(daysAgo(day)),
        })
        .run();
      sampleRows += 1;
    }

    // Two snapshots a day apart per channel: the overview reports subscribers as
    // the summed growth across every channel, so only one of the four moves —
    // otherwise four flat +11s would read back as the reference's single "+11"
    // times four.
    for (const [platform, followers, gained] of [
      ["youtube_ru", 8_400, 11],
      ["youtube_en", 1_260, 0],
      ["instagram_ru", 5_120, 0],
      ["instagram_en", 940, 0],
    ] as const)
      for (const [when, value] of [
        [daysAgo(1), followers],
        [now, followers + gained],
      ] as const)
        backendDb.db
          .insert(creatorProfileSnapshots)
          .values({
            platform,
            account: "alexgetman",
            sampledOn: iso(when).slice(0, 10),
            metricsJson: { subscriberCount: value },
            source: "fixture",
            sampledAt: iso(when),
          })
          .run();
  } finally {
    backendDb.close();
  }

  return { targetRows, sampleRows };
}
