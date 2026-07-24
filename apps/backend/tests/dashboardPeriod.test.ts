import { describe, expect, it } from "bun:test";
import { renderPeriodControls, renderPipelineSection } from "../src/operations/dashboard/pipeline-section.js";
import type { PipelineData, PipelinePost } from "../src/operations/dashboard/types.js";

function post(views: number): PipelinePost {
  return {
    targets: { telegram: { status: "published" } },
    metrics: { telegram: { views: { value: views }, likes: { value: 0 }, replies: { value: 0 }, reposts: { value: 0 } } },
  };
}

describe("command center periods", () => {
  it("offers one day first and compares it to the 30-day daily average", () => {
    const current: PipelineData = { posts: [post(200)] };
    const benchmark: PipelineData = { posts: Array.from({ length: 30 }, () => post(100)) };

    const html = renderPipelineSection(0, 1, current, benchmark, "", "Europe/Moscow", 30);

    expect(renderPeriodControls(0, 1)).toContain(">1д<");
    expect(html).toContain("vs среднее за 30д");
    expect(html).toContain("↑ 100%");
  });
});
