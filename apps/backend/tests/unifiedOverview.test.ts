import { describe, expect, it } from "bun:test";
import type { XActivityDashboardItem } from "../src/analytics/x-activity-dashboard.js";
import { openBackendDb } from "../src/db/client.js";
import { creatorProfileSnapshots, videoDrafts, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";
import { renderCombinedSection } from "../src/interfaces/web/dashboard/combined-section.js";
import { renderHeroCard } from "../src/interfaces/web/dashboard/hero-section.js";
import { renderTrackPublicationList } from "../src/interfaces/web/dashboard/table.js";
import type { PipelinePost } from "../src/interfaces/web/dashboard/types.js";
import { emptyVideoOverview, videoOverview } from "../src/interfaces/web/dashboard/video-overview.js";

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

/** rollingPeriodDates hands the renderer a UTC-midnight Date carrying the
 * zone's calendar fields; the chart reads it back with getUTC*. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function seedVideo(backendDb: ReturnType<typeof openBackendDb>): void {
  const publishedAt = hoursAgo(3);
  const draft = backendDb.db
    .insert(videoDrafts)
    .values({
      actorId: 1,
      locale: "ru",
      label: "Seedance 2.5",
      assetKey: "asset-1",
      status: "published",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoDrafts.id })
    .get();
  const target = backendDb.db
    .insert(videoTargets)
    .values({
      videoDraftId: draft.id,
      target: "youtube_shorts",
      metadataJson: { title: "Seedance 2.5", description: "", tags: [], videoDurationMs: 24_000 },
      status: "published",
      publishedAt,
      externalUrl: "https://youtube.com/shorts/abc",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoTargets.id })
    .get();
  // Two observations of the same target: the later one must replace the earlier,
  // not be added to it.
  for (const [hours, views] of [
    [3, 400],
    [1, 1_000],
  ] as const)
    backendDb.db
      .insert(videoMetricSnapshots)
      .values({
        videoTargetId: target.id,
        platform: "youtube_shorts",
        metricsJson: {
          views,
          likes: views / 10,
          comments: 4,
          ...(hours === 1 ? { totalWatchTimeMs: 12_000_000 } : {}),
        },
        sampledAt: hoursAgo(hours),
      })
      .run();
  backendDb.db
    .insert(creatorProfileSnapshots)
    .values({
      platform: "youtube_ru",
      account: "alexgetman",
      sampledOn: new Date().toISOString().slice(0, 10),
      metricsJson: { subscriberCount: 8_400 },
      source: "fixture",
      sampledAt: hoursAgo(1),
    })
    .run();
}

function seedLocalizedVideoProfiles(backendDb: ReturnType<typeof openBackendDb>): void {
  for (const [platform, account, followers] of [
    ["youtube_ru", "Marux_play", 8_400],
    ["youtube_en", "Marux_plays", 1_260],
    ["instagram_ru", "marux_play", 5_120],
    ["instagram_en", "marux_plays", 940],
  ] as const)
    backendDb.db
      .insert(creatorProfileSnapshots)
      .values({
        platform,
        account,
        sampledOn: new Date().toISOString().slice(0, 10),
        metricsJson: { subscriberCount: followers },
        source: "fixture",
        sampledAt: new Date().toISOString(),
      })
      .run();
}

function seedHistoricalVideo(backendDb: ReturnType<typeof openBackendDb>): void {
  const publishedAt = "2026-07-30T08:00:00.000Z";
  const draft = backendDb.db
    .insert(videoDrafts)
    .values({
      actorId: 1,
      locale: "ru",
      label: "Historical clip",
      assetKey: "historical-asset",
      status: "published",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoDrafts.id })
    .get();
  const target = backendDb.db
    .insert(videoTargets)
    .values({
      videoDraftId: draft.id,
      target: "youtube_shorts",
      metadataJson: { title: "Historical clip", description: "", tags: [] },
      status: "published",
      publishedAt,
      externalUrl: "https://youtube.com/shorts/historical",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    .returning({ id: videoTargets.id })
    .get();
  for (const [sampledAt, views] of [
    ["2026-07-30T12:00:00.000Z", 100],
    ["2026-07-30T20:00:00.000Z", 800],
    ["2026-07-31T20:00:00.000Z", 1_500],
    ["2026-08-01T20:00:00.000Z", 2_300],
  ] as const)
    backendDb.db
      .insert(videoMetricSnapshots)
      .values({
        videoTargetId: target.id,
        platform: "youtube_shorts",
        metricsJson: { views, likes: views / 10, comments: 2 },
        sampledAt,
      })
      .run();
  backendDb.db
    .insert(creatorProfileSnapshots)
    .values([
      {
        platform: "youtube_ru",
        account: "marux",
        sampledOn: "2026-07-29T20",
        metricsJson: { subscriberCount: 100 },
        source: "fixture",
        sampledAt: "2026-07-29T20:00:00.000Z",
      },
      {
        platform: "youtube_ru",
        account: "marux",
        sampledOn: "2026-07-30T20",
        metricsJson: { subscriberCount: 107 },
        source: "fixture",
        sampledAt: "2026-07-30T20:00:00.000Z",
      },
    ])
    .run();
}

describe("unified overview video read model", () => {
  it("reports the latest sample per publication and names the destination", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedVideo(backendDb);
      const overview = videoOverview(backendDb, new Date(Date.now() - 86_400_000), new Date());

      expect(overview.items).toHaveLength(1);
      expect(overview.totals.views).toBe(1_000);
      expect(overview.totals.reactions).toBe(100);
      // Comments are the video answer to replies.
      expect(overview.totals.replies).toBe(4);
      expect(overview.items[0]?.url).toBe("https://youtube.com/shorts/abc");
      // The platform alone is not the destination: a Russian draft on Shorts is
      // the Russian channel.
      expect(overview.items[0]?.label).toBe("YouTube RU");

      expect(overview.platforms.map((platform) => platform.label)).toEqual(["YouTube RU"]);
      expect(overview.platforms[0]?.views).toBe(1_000);
      // The Russian destination has its own audience snapshot.
      expect(overview.platforms[0]?.followers).toBe(8_400);
      expect(overview.summary.completionRate).toBe(50);
      expect(overview.summary.subscribers).toBeNull();
    } finally {
      backendDb.close();
    }
  });

  it("keeps declared destinations and their audiences independent of the period", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedVideo(backendDb);
      seedLocalizedVideoProfiles(backendDb);
      const overview = videoOverview(backendDb, new Date(Date.now() - 86_400_000), new Date());

      expect(overview.platforms.map((platform) => platform.label)).toEqual(["YouTube RU", "YouTube EN", "Instagram RU", "Instagram EN"]);
      expect(overview.platforms.map((platform) => platform.followers)).toEqual([16_800, 1_260, 5_120, 940]);
      expect(overview.platforms.map((platform) => platform.views)).toEqual([1_000, 0, 0, 0]);

      const quiet = videoOverview(backendDb, new Date(Date.now() - 10 * 86_400_000), new Date(Date.now() - 5 * 86_400_000));
      expect(quiet.platforms.map((platform) => platform.label)).toEqual(["YouTube RU", "YouTube EN", "Instagram RU", "Instagram EN"]);
      expect(quiet.platforms.every((platform) => platform.views === 0)).toBe(true);
    } finally {
      backendDb.close();
    }
  });

  it("excludes publications outside the window", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedVideo(backendDb);
      const older = videoOverview(backendDb, new Date(Date.now() - 10 * 86_400_000), new Date(Date.now() - 5 * 86_400_000));
      expect(older.items).toHaveLength(0);
      expect(older.totals.views).toBe(0);
    } finally {
      backendDb.close();
    }
  });

  it("freezes a historical period and exposes later lifetime growth separately", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedHistoricalVideo(backendDb);
      const overview = videoOverview(backendDb, new Date("2026-07-29T21:00:00.000Z"), new Date("2026-07-30T20:59:59.999Z"));

      expect(overview.totals.views).toBe(800);
      expect(overview.items[0]?.views).toBe(800);
      expect(overview.items[0]?.lifetimeViews).toBe(2_300);
      expect(overview.items[0]?.afterPeriodViews).toBe(1_500);
      expect(overview.summary.subscribers).toBe(7);
      expect(overview.dailyByDay["2026-07-30"]?.subscribers).toBe(7);
      expect(overview.dailyByDay["2026-07-30"]?.views).toBe(800);
      expect(overview.viewEvents.map((event) => event.value)).toEqual([100, 800]);
    } finally {
      backendDb.close();
    }
  });

  it("sums daily increments for a multi-day period instead of lifetime totals", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedHistoricalVideo(backendDb);
      const overview = videoOverview(backendDb, new Date("2026-07-29T21:00:00.000Z"), new Date("2026-07-31T20:59:59.999Z"));

      expect(overview.totals.views).toBe(1_500);
      expect(overview.dailyByDay["2026-07-30"]?.views).toBe(800);
      expect(overview.dailyByDay["2026-07-31"]?.views).toBe(700);
      expect(overview.dailyByDay["2026-07-30"]?.subscribers).toBe(7);
      expect(overview.dailyByDay["2026-07-31"]?.subscribers).toBe(0);
      expect(overview.items[0]?.afterPeriodViews).toBe(800);
    } finally {
      backendDb.close();
    }
  });
});

describe("unified overview rendering", () => {
  const baseInput = {
    data: { posts: [] },
    previousData: { posts: [] },
    xItems: [],
    previousXItems: [],
    dayComparisonData: { posts: [] },
    previousVideo: emptyVideoOverview(),
    dayComparisonVideo: emptyVideoOverview(),
    followers: [{ key: "telegram", label: "Telegram", followers: 135 }],
    // The seeded samples are relative to now, so the window has to be too.
    rangeStart: today(),
    rangeEnd: today(),
    periodDays: 1,
    weekOffset: 0,
    timeZone: "Europe/Moscow",
    platformMetric: "reach" as const,
  };

  it("shows both halves separately and never their sum", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedVideo(backendDb);
      const video = videoOverview(backendDb, new Date(Date.now() - 86_400_000), new Date());
      const html = renderCombinedSection({ ...baseInput, video, mode: "all" });

      expect(html).toContain("<strong>1k</strong>");
      expect(html).toContain("Текст");
      expect(html).toContain("Видео");
      expect(html).toContain('class="overview-split"');
      expect(html).toContain('class="overview-track overview-track--text"');
      expect(html).toContain('class="overview-track overview-track--video"');
      expect(html).toContain('class="overview-spark"');
      expect(html).toContain('class="overview-spark__cap"');
      expect(html).not.toContain('class="overview-spark__head"');
      expect(html).not.toContain('class="overview-spark__view');
      expect(html).not.toContain("логарифмическая");
      expect(html).toContain("норма дня");
      expect(html).toContain("досмотры");
      expect(html).not.toContain('class="kpi-table');
      expect(html).not.toContain("kpi-table__row--head");
      expect(html).not.toContain("vs медиана за 30д");
      expect(html).toContain("пунктир — медиана за 30 дней");
      expect(html).not.toContain("вчера к этому времени");
      // The scale toggle only earns its place when two series share the axis.
      expect(html).toContain('class="chart-scale"');
      expect(html).toContain('data-scale="absolute" aria-pressed="false"');
      expect(html).toContain('data-scale="relative" aria-pressed="true"');
      expect(html).toContain('class="chart-view chart-view--absolute"');
      expect(html).toContain('class="chart-view chart-view--relative"');
    } finally {
      backendDb.close();
    }
  });

  it("compares multi-day totals with the previous multi-day totals", () => {
    const post = (views: number): PipelinePost => ({
      targets: { telegram: { status: "published" } },
      metrics: { telegram: { views: { value: views } } },
    });
    const currentVideo = {
      ...emptyVideoOverview(),
      totals: { views: 300, reactions: 0, replies: 0, posts: 0 },
    };
    const previousVideo = {
      ...emptyVideoOverview(),
      totals: { views: 100, reactions: 0, replies: 0, posts: 0 },
    };
    const html = renderCombinedSection({
      ...baseInput,
      periodDays: 30,
      data: { posts: [post(300)] },
      previousData: { posts: [post(100)] },
      video: currentVideo,
      previousVideo,
      mode: "all",
    });

    expect(html).toContain("+200%");
    expect(html).not.toContain("vs прошлый период");
    expect(html).not.toContain("↑ 2900%");
  });

  it("compares one-day totals with the previous 30-day median", () => {
    const post = (views: number, date: string): PipelinePost => ({
      date,
      targets: { telegram: { status: "published" } },
      metrics: { telegram: { views: { value: views } } },
    });
    const previousPosts = Array.from({ length: 30 }, (_, index) =>
      post(100, `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
    );
    const html = renderCombinedSection({
      ...baseInput,
      data: { posts: [post(200, "2026-08-01T12:00:00.000Z")] },
      previousData: { posts: previousPosts },
      video: emptyVideoOverview(),
      mode: "text",
    });

    expect(html).toContain("+100%");
    expect(html).not.toContain("vs медиана за 30д");
    expect(html).toContain("Текст: 200");
  });

  it("derives the locale badge from the data rather than from the platform name", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedVideo(backendDb);
      const video = videoOverview(backendDb, new Date(Date.now() - 86_400_000), new Date());
      // The seeded draft is Russian, so its platform is badged RU.
      expect(video.platforms.find((platform) => platform.target === "youtube_shorts")?.locales).toEqual(["RU"]);
      // Nothing published on Reels this period, so its language is unknown and
      // the panel must not invent one.
      expect(video.platforms.some((platform) => platform.target === "instagram_reels")).toBe(false);

      const html = renderCombinedSection({
        ...baseInput,
        video,
        // Telegram declares "ru" and X declares "en" in the target table; the
        // panel must not be reading the "_ru"/"_en" suffix of the id.
        followers: [
          { key: "telegram", label: "Telegram", followers: 135 },
          { key: "x", label: "X", followers: 83 },
        ],
        mode: "all",
      });
      // The source name and locale badge must come from the data, not from a
      // guessed suffix in the target id.
      expect(html).toContain('class="overview-platform__name"><span class="overview-platform__label">Telegram</span><b>RU</b>');
      expect(html).toContain('class="overview-platform__name"><span class="overview-platform__label">X</span><b>EN</b>');
    } finally {
      backendDb.close();
    }
  });

  it("switches platform rows between reach and followers while preserving the mode", () => {
    const followers = [
      { key: "telegram", label: "Telegram", followers: 135 },
      { key: "x", label: "X", followers: 85 },
    ];
    const reachHtml = renderCombinedSection({ ...baseInput, followers, video: emptyVideoOverview(), mode: "text" });
    const followerHtml = renderCombinedSection({
      ...baseInput,
      followers,
      video: emptyVideoOverview(),
      mode: "text",
      platformMetric: "followers",
    });

    expect(reachHtml).toContain('href="/command-center?period=1&week_offset=0&mode=text&metric=followers"');
    expect(reachHtml).toContain('class="platform-metric-btn platform-metric-btn--active"');
    expect(followerHtml).toContain(">135</strong>");
    // The metric is named by the active switch itself; the panel carries no
    // separate heading repeating it.
    expect(followerHtml).toContain('aria-pressed="true">Подписчики</a>');
    expect(followerHtml).toContain('href="/command-center?period=1&week_offset=0&mode=text"');
  });

  it("offers the full list only when the column actually hides rows", () => {
    const post = (index: number, views: number): PipelinePost => ({
      post_key: `post-${index}`,
      date: hoursAgo(index + 1),
      text_ru: `Пост ${index}`,
      targets: { telegram: { status: "published" } },
      metrics: { telegram: { views: { value: views } } },
    });
    const many = renderTrackPublicationList(
      [1, 2, 3, 4, 5, 6].map((index) => post(index, index * 100)),
      ["telegram"],
      [],
      {
        limit: 4,
        moreUrl: "/api/publication-details",
      },
    );
    const few = renderTrackPublicationList([post(1, 100)], ["telegram"], [], { limit: 4, moreUrl: "/api/publication-details" });

    expect(many).toContain('<a class="track-publication__more" href="/api/publication-details">показать все 6</a>');
    expect(few).not.toContain("track-publication__more");
  });

  it("turns the heading gauge green once the norm is beaten", () => {
    const metrics = {
      postCount: 3,
      views: 4_128,
      medianViews: 3_600,
      reactions: 147,
      replies: 23,
      reposts: 9,
      engagementRate: 3.6,
      countLabel: "3 поста сегодня",
      normLabel: "норма дня",
      contextLabel: "ОХВАТ · 2 АВГ",
      paceLabel: "норма побита · прогноз 9.3k",
      projectionViews: 9_300,
      progressPercent: 114,
    };
    const won = renderHeroCard("text", metrics);
    const behind = renderHeroCard("text", { ...metrics, views: 1_200, paceLabel: "до нормы 2.4k", progressPercent: 33 });

    expect(won).toContain("overview-hero-card__heading--win");
    // The norm is an aside on the number's line, not a stacked second KPI.
    expect(won).toContain("норма дня · <b>3.6k</b>");
    expect(won).not.toContain("Просмотры");
    expect(behind).not.toContain("overview-hero-card__heading--win");
  });

  it("sorts text and video platform rows by the selected metric", () => {
    const post: PipelinePost = {
      targets: {
        telegram: { status: "published" },
        threads_ru: { status: "published" },
        site_ru: { status: "published" },
        x: { status: "published" },
      },
      metrics: {
        telegram: { views: { value: 100 } },
        threads_ru: { views: { value: 50 } },
        site_ru: { views: { value: 28 } },
        x: { views: { value: 20 } },
      },
    };
    const video = {
      ...emptyVideoOverview(),
      platforms: [
        { target: "instagram_reels", label: "Instagram EN", locales: ["EN"], views: 20, followers: 2 },
        { target: "youtube_shorts", label: "YouTube RU", locales: ["RU"], views: 10, followers: 500 },
        { target: "instagram_reels", label: "Instagram RU", locales: ["RU"], views: 30, followers: 250 },
      ],
    };
    const followers = [
      { key: "telegram", label: "Telegram", followers: 10 },
      { key: "threads_ru", label: "Threads RU", followers: 200 },
      { key: "x", label: "X", followers: 400 },
    ];
    const column = (html: string, kind: "text" | "video"): string => {
      const start = html.indexOf(`class="overview-track overview-track--${kind}`);
      const end = html.indexOf(`<div class="overview-publications" id="overview-publications-${kind}">`, start);
      return html.slice(start, end < 0 ? undefined : end);
    };
    const assertOrder = (html: string, labels: string[]): void => {
      const positions = labels.map((label) => html.indexOf(`title="${label}"`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      for (let index = 1; index < positions.length; index += 1) expect(positions[index - 1] ?? -1).toBeLessThan(positions[index] ?? -1);
    };

    const reachHtml = renderCombinedSection({
      ...baseInput,
      data: { posts: [post] },
      followers,
      video,
      mode: "all",
      platformMetric: "reach",
    });
    const reachText = column(reachHtml, "text");
    const reachVideo = column(reachHtml, "video");
    assertOrder(reachText, ["Telegram", "Threads RU", "Site RU", "X"]);
    assertOrder(reachVideo, ["Instagram RU", "Instagram EN", "YouTube RU"]);

    const followerHtml = renderCombinedSection({
      ...baseInput,
      data: { posts: [post] },
      followers,
      video,
      mode: "all",
      platformMetric: "followers",
    });
    const followerText = column(followerHtml, "text");
    const followerVideo = column(followerHtml, "video");
    assertOrder(followerText, ["X", "Threads RU", "Telegram"]);
    assertOrder(followerVideo, ["YouTube RU", "Instagram RU", "Instagram EN"]);
  });

  it("shows the four largest text destinations and keeps the rest behind a compact drawer", () => {
    const post: PipelinePost = {
      post_key: "post:1",
      targets: {
        site_ru: { status: "published" },
        site_en: { status: "published" },
        telegram_stories: { status: "published" },
        instagram_stories: { status: "published" },
      },
      metrics: {
        site_ru: { views: { value: 4 }, bot_views: { value: 0 } },
        site_en: { views: { value: 8 }, bot_views: { value: 0 } },
        telegram_stories: { views: { value: 12 } },
        instagram_stories: { views: { value: 3 } },
      },
    };
    const html = renderCombinedSection({
      ...baseInput,
      data: { posts: [post] },
      video: emptyVideoOverview(),
      mode: "text",
    });
    // Scoped to the row list, not the whole block: the bar still names every
    // source in its tooltip, while the rows keep only the first four visible.
    const platformHtml = html.slice(
      html.indexOf('<div class="overview-platforms__rows">'),
      html.indexOf('<div class="overview-publications" id="overview-publications-text">'),
    );
    const moreIndex = platformHtml.indexOf('<details class="overview-platforms__more platform-more">');
    expect(moreIndex).toBeGreaterThan(0);
    expect(platformHtml.slice(0, moreIndex)).toContain("Telegram Stories");
    expect(platformHtml.slice(0, moreIndex)).toContain("Site EN");
    expect(platformHtml.slice(0, moreIndex)).toContain("Site RU");
    expect(platformHtml.slice(0, moreIndex)).toContain("Instagram Stories EN");
    expect(platformHtml.slice(0, moreIndex)).not.toContain('title="Telegram"');
    expect(platformHtml.slice(moreIndex)).toContain('title="Telegram"');
    expect(platformHtml).toContain("Ещё <span>1</span>");

    const followersHtml = renderCombinedSection({
      ...baseInput,
      data: { posts: [post] },
      video: emptyVideoOverview(),
      mode: "text",
      platformMetric: "followers",
    });
    const followersPlatformHtml = followersHtml.slice(
      followersHtml.indexOf('<div class="overview-platforms__rows">'),
      followersHtml.indexOf('<div class="overview-publications" id="overview-publications-text">'),
    );
    expect(followersPlatformHtml).not.toContain("Telegram Stories");
    expect(followersPlatformHtml).not.toContain("platform-more");
  });

  it("keeps a compact publication control under a full four-row video legend", () => {
    const video = {
      ...emptyVideoOverview(),
      platforms: [
        { target: "instagram_reels", label: "Instagram RU", locales: ["RU"], views: 48_000, followers: null },
        { target: "instagram_reels", label: "Instagram EN", locales: ["EN"], views: 34_000, followers: null },
        { target: "youtube_shorts", label: "YouTube EN", locales: ["EN"], views: 15_000, followers: null },
        { target: "youtube_shorts", label: "YouTube RU", locales: ["RU"], views: 9_000, followers: null },
      ],
    };
    const html = renderCombinedSection({ ...baseInput, video, mode: "video" });
    const videoStart = html.indexOf('<section class="overview-track overview-track--video');
    const videoEnd = html.indexOf('<div class="overview-publications" id="overview-publications-video">', videoStart);
    const videoPlatformHtml = html.slice(videoStart, videoEnd);

    expect(videoPlatformHtml).toContain(
      '<a class="overview-platforms__more overview-platforms__more--jump" href="#overview-publications-video">Публикации</a>',
    );
    expect(videoPlatformHtml).not.toContain("overview-platform--empty");
    expect(html).toContain('id="overview-publications-video"');
  });

  it("uses linked X activity when the pipeline row has no X metric", () => {
    const xItems: XActivityDashboardItem[] = [
      {
        xPostId: "x-1",
        kind: "standalone",
        publishedAt: new Date().toISOString(),
        text: "An X post",
        url: "https://x.com/example/status/x-1",
        linkedPostKey: "post:1",
        metrics: { views: 42 },
      },
    ];
    const post: PipelinePost = {
      post_key: "post:1",
      targets: { x: { status: "published" } },
      metrics: { x: { views: { value: 0 } } },
    };
    const html = renderCombinedSection({
      ...baseInput,
      data: { posts: [post] },
      xItems,
      followers: [{ key: "x", label: "X", followers: 85 }],
      video: emptyVideoOverview(),
      mode: "text",
    });

    expect(html).toContain("<strong>42</strong>");
  });

  it("drops the other half entirely when the mode selects one", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      seedVideo(backendDb);
      const video = videoOverview(backendDb, new Date(Date.now() - 86_400_000), new Date());
      const textOnly = renderCombinedSection({ ...baseInput, video, mode: "text" });
      expect(textOnly).not.toContain("YouTube Shorts");
      expect(textOnly).toContain("Telegram");

      const videoOnly = renderCombinedSection({ ...baseInput, video, mode: "video" });
      expect(videoOnly).toContain("YouTube RU");
      expect(videoOnly).not.toContain("Telegram");
    } finally {
      backendDb.close();
    }
  });
});
