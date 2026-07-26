import { describe, expect, it } from "bun:test";
import { renderDailyComparisonChart } from "../src/interfaces/web/dashboard/chart.js";
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
});
