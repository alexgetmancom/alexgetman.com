import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importXAnalyticsCsv } from "../src/analytics/import-x-csv.js";
import { xActivityItems, xActivityMetricSnapshots } from "../src/db/schema.js";
import { type CombinedSectionInput, renderCombinedSection, xChartPost } from "../src/interfaces/web/dashboard/combined-section.js";
import { calendarDays } from "../src/interfaces/web/dashboard/daily-reach.js";
import { textOverviewOf } from "../src/interfaces/web/dashboard/text-overview.js";
import { emptyVideoOverview } from "../src/interfaces/web/dashboard/video-overview.js";
import { openBackendDb } from "./helpers/open-db.js";

const HEADERS = [
  "Идентификатор поста",
  "Дата",
  "Текст поста",
  "Ссылка на пост",
  "Показы",
  "Нравится",
  "Взаимодействия",
  "Закладки",
  "Поделились",
  "Новые читатели",
  "Ответы",
  "Репосты",
  "Посещения профиля",
  "Разворачивания подробных сведений",
  "Клики по URL-адресам",
  "Клики по хештегам",
  "Клики по постоянным ссылкам",
];

/** The renderer reads daily reach, which the read model derives from these very
 * posts; the tests derive it the same way instead of restating the numbers. */
function renderOverview(input: Omit<CombinedSectionInput, "textReach" | "videoReach">): string {
  const start = new Date(input.rangeEnd);
  start.setUTCDate(start.getUTCDate() - (input.periodDays + 40));
  const days = calendarDays(start, new Date(input.rangeEnd.getTime() + 86_400_000 - 1), "UTC");
  // Without a database the X rows arrive as items, so they stand in for the
  // series the read model would load — including the rule that an X row wins
  // over the pipeline's own copy of the same tweet.
  const items = input.xItems ?? [];
  const covered = new Set(items.map((item) => item.linkedPostKey).filter(Boolean));
  const posts = [...(input.data?.posts ?? []), ...(input.previousData?.posts ?? [])].map((post) =>
    post.post_key && covered.has(post.post_key) ? { ...post, targets: { ...post.targets, x: undefined } } : post,
  );
  return renderCombinedSection({
    ...input,
    videoReach: input.video.dailyByDay,
    textReach: textOverviewOf([...posts, ...items.map(xChartPost)], [], days, "UTC"),
  });
}

describe("X Activity", () => {
  it("imports linked posts and account-wide replies without adding editorial posts", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = "2026-07-29T11:49:00.000Z";
      backendDb.sqlite
        .prepare(
          "INSERT INTO posts(post_key,post_id,channel,message_id,date_utc,text_en,status,created_at,updated_at) VALUES ('post:1',1,'test',1,?,'A linked Studio post','active',?,?)",
        )
        .run(now, now, now);
      backendDb.sqlite
        .prepare(
          "INSERT INTO post_targets(post_key,target,status,external_id,url,updated_at) VALUES ('post:1','x','published','100','https://x.com/test/status/100',?)",
        )
        .run(now);
      const directory = mkdtempSync(join(tmpdir(), "x-activity-"));
      const file = join(directory, "account_analytics_content_2026-07-23_2026-07-29.csv");
      const metricValues = (views: number) => [views, 2, 4, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0];
      writeFileSync(
        file,
        [
          HEADERS.join(","),
          ["100", '"Wed, Jul 29, 2026"', "A linked Studio post", "https://x.com/test/status/100", ...metricValues(50)].join(","),
          ["101", '"Wed, Jul 29, 2026"', "@friend Useful answer", "https://x.com/test/status/101", ...metricValues(500)].join(","),
        ].join("\n"),
      );

      const result = importXAnalyticsCsv(backendDb, file, now);

      expect(result).toMatchObject({ matchedPosts: 1, activityItems: 2, activitySamples: 26 });
      expect(backendDb.db.select().from(xActivityItems).all()).toMatchObject([
        { xPostId: "100", kind: "standalone", linkedPostKey: "post:1" },
        { xPostId: "101", kind: "reply", linkedPostKey: null },
      ]);
      expect(backendDb.db.select().from(xActivityMetricSnapshots).all()).toHaveLength(26);
      expect((backendDb.sqlite.prepare("SELECT count(*) AS count FROM posts").get() as { count: number }).count).toBe(1);

      const repeated = importXAnalyticsCsv(backendDb, file, now);
      expect(repeated.activitySamples).toBe(0);
      expect(backendDb.db.select().from(xActivityItems).all()).toHaveLength(2);
    } finally {
      backendDb.close();
    }
  });

  it("adds only X activity that is not already represented in the editorial totals", () => {
    const editorial = {
      posts: [
        {
          post_key: "post:1",
          date: "2026-07-29T10:00:00.000Z",
          text_en: "Editorial post",
          targets: {
            telegram: { status: "published" },
            x: { status: "published" },
          },
          metrics: {
            telegram: {
              views: { value: 100 },
              likes: { value: 4 },
              replies: { value: 2 },
              reposts: { value: 1 },
            },
            x: {
              views: { value: 50 },
              likes: { value: 2 },
              replies: { value: 1 },
              reposts: { value: 1 },
            },
          },
        },
      ],
    };
    const items = [
      {
        xPostId: "100",
        kind: "standalone" as const,
        publishedAt: "2026-07-29T10:00:00.000Z",
        text: "Editorial post",
        url: "https://x.com/test/status/100",
        linkedPostKey: "post:1",
        metrics: { views: 50, interactions: 8, replies: 1 },
      },
      {
        xPostId: "101",
        kind: "reply" as const,
        publishedAt: "2026-07-29T11:00:00.000Z",
        text: "@friend Useful answer",
        url: "https://x.com/test/status/101",
        linkedPostKey: null,
        metrics: { views: 500, interactions: 40, replies: 3 },
      },
    ];

    const html = renderOverview({
      data: editorial,
      previousData: { posts: [] },
      xItems: items,
      previousXItems: [],
      dayComparisonData: { posts: [] },
      video: emptyVideoOverview(),
      previousVideo: emptyVideoOverview(),
      dayComparisonVideo: emptyVideoOverview(),
      followers: [{ key: "x", label: "X", followers: 83 }],
      rangeStart: new Date("2026-07-29"),
      rangeEnd: new Date("2026-07-29"),
      periodDays: 1,
      weekOffset: 0,
      timeZone: "Europe/Moscow",
      platformMetric: "reach",
    });

    // Standalone X activity is folded into the text half: 150 from the post's
    // targets plus 500 from the unlinked reply.
    expect(html).toContain("<strong>650</strong>");
    expect(html).toContain("ПУБЛИКАЦИИ");
    expect(html).not.toContain("Детальная динамика и публикации");
    // The two halves are reported separately and never added together.
    expect(html).toContain("Текст");
    expect(html).toContain("Видео");
    // The unified overview has no content-type mode switch.
    expect(html).not.toContain('class="mode-filter"');
  });
});
