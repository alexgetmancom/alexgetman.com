import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { ORDERED_TARGETS } from "./assets.js";
import { renderWeeklyChart } from "./chart.js";
import { formatMetricValue } from "./format.js";
import { postMetricTotals } from "./metrics.js";
import { renderCompactBestPosts } from "./table.js";
import type { PipelineData, PipelinePost } from "./types.js";
import { renderCompactXBest } from "./x-section.js";

type Totals = { views: number; reactions: number; replies: number; posts: number };

export function renderCombinedSection(
  data: PipelineData | null,
  previousData: PipelineData | null,
  xItems: XActivityDashboardItem[],
  previousXItems: XActivityDashboardItem[],
  audience: string,
  rangeStart: Date,
  rangeEnd: Date,
  periodDays: number,
  weekOffset: number,
): string {
  const posts = data?.posts ?? [];
  const previousPosts = previousData?.posts ?? [];
  const extraX = additionalXItems(posts, xItems);
  const previousExtraX = additionalXItems(previousPosts, previousXItems);
  const totals = combinedTotals(posts, extraX);
  const previous = combinedTotals(previousPosts, previousExtraX);
  const core = pipelineTotals(posts);
  const xOnly = xTotals(extraX);
  const chartPosts = [...posts, ...extraX.map(xChartPost)];

  return `<section class="pipeline-overview">
    <div class="kpi-row">
      ${combinedKpi("Просмотры", totals.views, previous.views, `${formatMetricValue(core.views)} основные · +${formatMetricValue(xOnly.views)} X Activity`)}
      ${combinedKpi("Реакции", totals.reactions, previous.reactions, `${formatMetricValue(core.reactions)} основные · +${formatMetricValue(xOnly.reactions)} X`)}
      ${combinedKpi("Ответы", totals.replies, previous.replies, `${formatMetricValue(core.replies)} основные · +${formatMetricValue(xOnly.replies)} X`)}
      ${combinedKpi("Публикации", totals.posts, previous.posts, `${posts.length} основных · +${extraX.length} в X`)}
    </div>
    <div class="insights-row">${audience}<div class="chart-panel"><div class="section-kicker">Общая динамика</div>${renderWeeklyChart(
      chartPosts,
      rangeStart,
      rangeEnd,
    )}</div></div>
    <div class="compact-rankings">
      <section class="best-posts"><div class="section-kicker">Лучшие публикации</div>${renderCompactBestPosts(posts)}</section>
      <section class="best-posts compact-rankings__x"><div class="section-kicker">Лучшее в X</div>${renderCompactXBest(xItems)}
        <a class="section-more" href="/command-center?period=${periodDays}&week_offset=${weekOffset}&view=x">Смотреть всё в X →</a>
      </section>
    </div>
  </section>`;
}

function additionalXItems(posts: PipelinePost[], items: XActivityDashboardItem[]): XActivityDashboardItem[] {
  const representedPostKeys = new Set(posts.map((post) => post.post_key).filter((key): key is string => Boolean(key)));
  return items.filter((item) => !item.linkedPostKey || !representedPostKeys.has(item.linkedPostKey));
}

function pipelineTotals(posts: PipelinePost[]): Omit<Totals, "posts"> {
  const targetIds = ORDERED_TARGETS.map((target) => target.id);
  return posts.reduce(
    (totals, post) => {
      const metrics = postMetricTotals(post, targetIds);
      totals.views += metrics.views;
      totals.reactions += metrics.likes + metrics.reposts;
      totals.replies += metrics.replies;
      return totals;
    },
    { views: 0, reactions: 0, replies: 0 },
  );
}

function xTotals(items: XActivityDashboardItem[]): Omit<Totals, "posts"> {
  return items.reduce(
    (totals, item) => {
      totals.views += metric(item, "views");
      totals.reactions += metric(item, "interactions");
      totals.replies += metric(item, "replies");
      return totals;
    },
    { views: 0, reactions: 0, replies: 0 },
  );
}

function combinedTotals(posts: PipelinePost[], extraX: XActivityDashboardItem[]): Totals {
  const core = pipelineTotals(posts);
  const x = xTotals(extraX);
  return {
    views: core.views + x.views,
    reactions: core.reactions + x.reactions,
    replies: core.replies + x.replies,
    posts: posts.length + extraX.length,
  };
}

function xChartPost(item: XActivityDashboardItem): PipelinePost {
  return {
    post_key: `x-activity:${item.xPostId}`,
    date: item.publishedAt,
    targets: { x: { status: "published" } },
    metrics: {
      x: {
        views: { value: metric(item, "views") },
        likes: { value: metric(item, "interactions") },
        replies: { value: metric(item, "replies") },
      },
    },
  };
}

function metric(item: XActivityDashboardItem, name: string): number {
  return Number(item.metrics[name] ?? 0);
}

function combinedKpi(label: string, value: number, previous: number, breakdown: string): string {
  const percent = previous > 0 ? Math.round(((value - previous) / previous) * 100) : value > 0 ? 100 : 0;
  const direction = percent >= 0 ? "up" : "down";
  return `<div class="kpi"><strong>${formatMetricValue(value)}</strong><span>${label}</span><small class="kpi-breakdown">${breakdown}</small><small class="kpi-delta kpi-delta--${direction}">${percent >= 0 ? "↑" : "↓"} ${Math.abs(percent)}% <i>vs прошлый период</i></small></div>`;
}
