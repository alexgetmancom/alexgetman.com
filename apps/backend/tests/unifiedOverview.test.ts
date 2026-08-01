import { describe, expect, it } from "bun:test";
import type { XActivityDashboardItem } from "../src/analytics/x-activity-dashboard.js";
import { openBackendDb } from "../src/db/client.js";
import { creatorProfileSnapshots, videoDrafts, videoMetricSnapshots, videoTargets } from "../src/db/schema.js";
import { renderCombinedSection, renderModeFilter } from "../src/interfaces/web/dashboard/combined-section.js";
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
      metadataJson: { title: "Seedance 2.5", description: "", tags: [] },
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
        metricsJson: { views, likes: views / 10, comments: 4 },
        sampledAt: hoursAgo(hours),
      })
      .run();
  backendDb.db
    .insert(creatorProfileSnapshots)
    .values({
      platform: "youtube",
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
      // No locale-scoped snapshot exists and only one channel published, so the
      // pre-split count is unambiguous and stands in.
      expect(overview.platforms[0]?.followers).toBe(8_400);
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
      expect(overview.platforms.map((platform) => platform.followers)).toEqual([8_400, 1_260, 5_120, 940]);
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
      expect(html).not.toContain("kpi-table__row--head");
      expect(html).not.toContain("vs медиана за 30д");
      // The scale toggle only earns its place when two series share the axis.
      expect(html).toContain('class="chart-scale"');
    } finally {
      backendDb.close();
    }
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
      expect(html).toContain('<b class="platform-locale">RU</b>');
      expect(html).toContain('<b class="platform-locale">EN</b>');
    } finally {
      backendDb.close();
    }
  });

  it("keeps the mode switch a set of links so the choice survives a reload", () => {
    const html = renderModeFilter("video", 7, 2);
    expect(html).toContain('href="/command-center?period=7&week_offset=2"');
    expect(html).toContain('href="/command-center?period=7&week_offset=2&mode=video"');
    expect(html).toContain("mode-btn--active");
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
    expect(followerHtml).toContain("подписчики");
    expect(followerHtml).toContain('href="/command-center?period=1&week_offset=0&mode=text"');
  });

  it("sorts text and video platform rows by the selected metric", () => {
    const post: PipelinePost = {
      targets: {
        telegram: { status: "published" },
        threads_ru: { status: "published" },
        x: { status: "published" },
      },
      metrics: {
        telegram: { views: { value: 100 } },
        threads_ru: { views: { value: 50 } },
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
    const panel = (html: string): string =>
      html.slice(html.indexOf('<aside class="audience-panel platform-panel">'), html.indexOf('<div class="chart-panel">'));
    const column = (html: string, index: number): string => {
      const start = html.indexOf('<div class="platform-column">', index);
      const end = html.indexOf('<div class="platform-column">', start + 1);
      return html.slice(start, end < 0 ? undefined : end);
    };
    const assertOrder = (html: string, labels: string[]): void => {
      const positions = labels.map((label) => html.indexOf(`title="${label}"`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      for (let index = 1; index < positions.length; index += 1) expect(positions[index - 1] ?? -1).toBeLessThan(positions[index] ?? -1);
    };

    const reachHtml = panel(
      renderCombinedSection({
        ...baseInput,
        data: { posts: [post] },
        followers,
        video,
        mode: "all",
        platformMetric: "reach",
      }),
    );
    const reachText = column(reachHtml, 0);
    const reachVideo = column(reachHtml, reachHtml.indexOf('<div class="platform-column">') + 1);
    assertOrder(reachText, ["Telegram", "Threads RU", "X"]);
    assertOrder(reachVideo, ["Instagram RU", "Instagram EN", "YouTube RU"]);

    const followerHtml = panel(
      renderCombinedSection({
        ...baseInput,
        data: { posts: [post] },
        followers,
        video,
        mode: "all",
        platformMetric: "followers",
      }),
    );
    const followerText = column(followerHtml, 0);
    const followerVideo = column(followerHtml, followerHtml.indexOf('<div class="platform-column">') + 1);
    assertOrder(followerText, ["X", "Threads RU", "Telegram"]);
    assertOrder(followerVideo, ["YouTube RU", "Instagram RU", "Instagram EN"]);
  });

  it("keeps low-volume site and story targets behind the extra platforms control", () => {
    const post: PipelinePost = {
      post_key: "post:1",
      targets: {
        site_ru: { status: "published" },
        telegram_stories: { status: "published" },
        instagram_stories: { status: "published" },
      },
      metrics: {
        site_ru: { views: { value: 4 }, bot_views: { value: 0 } },
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
    const platformHtml = html.slice(
      html.indexOf('<aside class="audience-panel platform-panel">'),
      html.indexOf('<div class="chart-panel">'),
    );
    const moreIndex = platformHtml.indexOf('<details class="platform-more">');

    expect(moreIndex).toBeGreaterThan(0);
    expect(platformHtml.slice(0, moreIndex)).toContain("Telegram Stories");
    expect(platformHtml.slice(0, moreIndex)).not.toContain("Site RU");
    expect(platformHtml.slice(moreIndex)).toContain("Site RU");
    expect(platformHtml.slice(moreIndex)).toContain("Instagram Stories EN");
    expect(platformHtml).toContain("+ Ещё <span>2</span>");

    const followersHtml = renderCombinedSection({
      ...baseInput,
      data: { posts: [post] },
      video: emptyVideoOverview(),
      mode: "text",
      platformMetric: "followers",
    });
    const followersPlatformHtml = followersHtml.slice(
      followersHtml.indexOf('<aside class="audience-panel platform-panel">'),
      followersHtml.indexOf('<div class="chart-panel">'),
    );
    expect(followersPlatformHtml).not.toContain("Telegram Stories");
    expect(followersPlatformHtml).not.toContain("platform-more");
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
