import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { zonedDateParts } from "../../../foundation/time.js";
import { ORDERED_TARGETS } from "./assets.js";
import { renderDailyComparisonChart, renderWeeklyChart } from "./chart.js";
import { formatMetricValue } from "./format.js";
import { postMetricTotals } from "./metrics.js";
import { renderPublicationColumns } from "./table.js";
import type { PipelineData, PipelinePost } from "./types.js";

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
  timeZone: string,
  dayComparisonData: PipelineData | null = null,
): string {
  const posts = data?.posts ?? [];
  const previousPosts = previousData?.posts ?? [];
  const extraX = additionalXItems(posts, xItems);
  const previousExtraX = additionalXItems(previousPosts, previousXItems);
  const totals = combinedTotals(posts, extraX);
  const previous =
    periodDays === 1
      ? medianDailyCombinedTotals(previousPosts, previousExtraX, 30, timeZone)
      : combinedTotals(previousPosts, previousExtraX);
  const core = pipelineTotals(posts);
  const xOnly = xTotals(extraX);
  const chartPosts = [...posts, ...extraX.map(xChartPost)];
  const comparisonLabel = periodDays === 1 ? "vs медиана за 30д" : "vs прошлый период";
  const chart =
    periodDays === 1
      ? renderDailyComparisonChart(posts, dayComparisonData?.posts ?? [], rangeEnd, timeZone)
      : renderWeeklyChart(chartPosts, rangeStart, rangeEnd);

  return `<section class="pipeline-overview">
    <div class="kpi-row">
      ${combinedKpi("Просмотры", totals.views, previous.views, `${formatMetricValue(core.views)} основные · +${formatMetricValue(xOnly.views)} X Activity`, comparisonLabel)}
      ${combinedKpi("Реакции", totals.reactions, previous.reactions, `${formatMetricValue(core.reactions)} основные · +${formatMetricValue(xOnly.reactions)} X`, comparisonLabel)}
      ${combinedKpi("Ответы", totals.replies, previous.replies, `${formatMetricValue(core.replies)} основные · +${formatMetricValue(xOnly.replies)} X`, comparisonLabel)}
      ${combinedKpi("Публикации", totals.posts, previous.posts, `${posts.length} основных · +${extraX.length} в X`, comparisonLabel)}
    </div>
    <div class="insights-row">${audience}<div class="chart-panel"><div class="section-kicker">${periodDays === 1 ? "Сегодня и вчера" : "Общая динамика"}</div>${chart}</div></div>
    ${renderPublicationColumns(posts)}
  </section>`;
}

function medianDailyCombinedTotals(posts: PipelinePost[], extraX: XActivityDashboardItem[], days: number, timeZone: string): Totals {
  const daily = new Map<string, Totals>();
  for (const post of posts) {
    const key = calendarKey(post.date, timeZone);
    if (!key) continue;
    const values = daily.get(key) ?? emptyTotals();
    const postTotals = pipelineTotals([post]);
    values.views += postTotals.views;
    values.reactions += postTotals.reactions;
    values.replies += postTotals.replies;
    values.posts += 1;
    daily.set(key, values);
  }
  for (const item of extraX) {
    const key = calendarKey(item.publishedAt, timeZone);
    if (!key) continue;
    const values = daily.get(key) ?? emptyTotals();
    const itemTotals = xTotals([item]);
    values.views += itemTotals.views;
    values.reactions += itemTotals.reactions;
    values.replies += itemTotals.replies;
    values.posts += 1;
    daily.set(key, values);
  }
  const values = [...daily.values()];
  while (values.length < days) values.push(emptyTotals());
  return {
    views: median(values.map((value) => value.views)),
    reactions: median(values.map((value) => value.reactions)),
    replies: median(values.map((value) => value.replies)),
    posts: median(values.map((value) => value.posts)),
  };
}

function emptyTotals(): Totals {
  return { views: 0, reactions: 0, replies: 0, posts: 0 };
}

function calendarKey(value: string | null | undefined, timeZone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle] ?? 0;
  if (ordered.length % 2) return upper;
  return ((ordered[middle - 1] ?? upper) + upper) / 2;
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

function combinedKpi(label: string, value: number, previous: number, breakdown: string, comparisonLabel: string): string {
  const percent = previous > 0 ? Math.round(((value - previous) / previous) * 100) : value > 0 ? 100 : 0;
  const direction = percent >= 0 ? "up" : "down";
  return `<div class="kpi"><strong>${formatMetricValue(value)}</strong><span>${label}</span><small class="kpi-breakdown">${breakdown}</small><small class="kpi-delta kpi-delta--${direction}">${percent >= 0 ? "↑" : "↓"} ${Math.abs(percent)}% <i>${comparisonLabel}</i></small></div>`;
}
