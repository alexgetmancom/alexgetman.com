import { describe, expect, it } from "bun:test";
import { renderDailyComparisonChart, renderWeeklyChart } from "../src/interfaces/web/dashboard/chart.js";
import { renderPeriodControls, renderPipelineSection } from "../src/interfaces/web/dashboard/pipeline-section.js";
import type { PipelineData, PipelinePost } from "../src/interfaces/web/dashboard/types.js";

function post(views: number, date?: string): PipelinePost {
  return {
    ...(date ? { date } : {}),
    targets: { telegram: { status: "published" } },
    metrics: { telegram: { views: { value: views }, likes: { value: 0 }, replies: { value: 0 }, reposts: { value: 0 } } },
  };
}

describe("command center periods", () => {
  it("offers one day first and compares it to the 30-day daily median", () => {
    const current: PipelineData = { posts: [post(200, "2026-07-24T12:00:00.000Z")] };
    const benchmark: PipelineData = {
      posts: Array.from({ length: 30 }, (_, index) =>
        post(index === 0 ? 1_000_000 : 100, `2026-06-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
      ),
    };

    const html = renderPipelineSection(0, 1, current, benchmark, "", "Europe/Moscow", 30);

    expect(renderPeriodControls(0, 1)).toContain(">1д<");
    expect(html).toContain("vs медиана за 30д");
    expect(html).toContain("↑ 100%");
  });

  it("renders a daily comparison from actual metric sample times", () => {
    const sampled: PipelinePost = {
      post_key: "post:1",
      metrics: {
        telegram: {
          views: {
            samples: [
              { value: 30, sampled_at: "2026-07-24T10:00:00.000Z" },
              { value: 90, sampled_at: "2026-07-24T12:00:00.000Z" },
            ],
          },
        },
      },
    };
    const html = renderDailyComparisonChart(
      [sampled],
      [],
      new Date("2026-07-24T00:00:00.000Z"),
      "Europe/Moscow",
      new Date("2026-07-24T15:00:00.000Z"),
    );

    expect(html).toContain("Сегодня: 90");
    expect(html).toContain("13:00");
    expect(html).toContain("реальные замеры");
  });

  it("links a platform ranking to that platform and excludes other target metrics", () => {
    const multiTarget: PipelinePost = {
      date: "2026-07-24T12:00:00.000Z",
      text_en: "A ranked post",
      telegram_url: "https://t.me/example/42",
      targets: {
        telegram: { status: "published" },
        threads_en: { status: "published", url: "https://www.threads.com/@example/post/99" },
      },
      metrics: {
        telegram: {
          views: { value: 200 },
          likes: { value: 10 },
          replies: { value: 2 },
          reposts: { value: 1 },
        },
        threads_en: {
          views: { value: 5_000 },
          likes: { value: 50 },
          replies: { value: 5 },
          reposts: { value: 5 },
        },
      },
    };

    const html = renderPipelineSection(0, 7, { posts: [multiTarget] }, { posts: [] }, "", "Europe/Moscow", 7, null, {
      targetIds: ["telegram"],
      title: "Динамика Telegram",
    });

    expect(html).toContain("<strong>200</strong>");
    expect(html).not.toContain("<strong>5.2k</strong>");
    expect(html).toContain('href="https://t.me/example/42"');
    expect(html).toContain("Динамика Telegram");
  });

  it("keeps long-period date labels readable without dropping daily data points", () => {
    const posts = Array.from({ length: 30 }, (_, index) =>
      post(100 + index, `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
    );
    const html = renderWeeklyChart(posts, new Date("2026-07-01"), new Date("2026-07-30"));

    expect((html.match(/<text /g) ?? []).length).toBeLessThanOrEqual(7);
    expect((html.match(/class="chart-point"/g) ?? []).length).toBe(90);
  });
});
