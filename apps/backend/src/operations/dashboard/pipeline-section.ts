import { zonedDateParts } from "../../foundation/time.js";
import { ORDERED_TARGETS } from "./assets.js";
import { renderWeeklyChart } from "./chart.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { postMetricTotals } from "./metrics.js";
import { renderPublicationColumns } from "./table.js";
import type { PipelineData } from "./types.js";

export { shortPipelineText };

const PERIODS = [7, 30, 90, 365] as const;

export function renderPipelineSection(
  weekOffset: number,
  periodDays: number,
  data: PipelineData | null,
  previousData: PipelineData | null,
  audience = "",
  timeZone = "Europe/Moscow",
): string {
  const [startOfPeriod, endOfPeriod] = rollingPeriodDates(weekOffset, periodDays, timeZone);
  const posts = data?.posts ?? [];
  const previousPosts = previousData?.posts ?? [];
  const targetIds = ORDERED_TARGETS.map((target) => target.id);
  const totals = posts.reduce(
    (all, post) => {
      const value = postMetricTotals(post, targetIds);
      all.views += value.views;
      all.likes += value.likes + value.reposts;
      all.replies += value.replies;
      return all;
    },
    { views: 0, likes: 0, replies: 0 },
  );
  const previousTotals = metricTotals(previousPosts, targetIds);
  return `
    <section class="pipeline-overview">
      <div class="kpi-row">${kpi("Просмотры", totals.views, previousTotals.views)}${kpi("Реакции", totals.likes, previousTotals.likes)}${kpi("Ответы", totals.replies, previousTotals.replies)}${kpi("Посты", posts.length, previousPosts.length)}</div>
      <div class="insights-row">${audience}<div class="chart-panel"><div class="section-kicker">Динамика</div>${renderWeeklyChart(posts, startOfPeriod, endOfPeriod)}</div></div>
      ${renderPublicationColumns(posts)}
    </section>
  `;
}

export function renderPeriodControls(weekOffset: number, periodDays: number, timeZone = "Europe/Moscow"): string {
  const [start, end] = rollingPeriodDates(weekOffset, periodDays, timeZone);
  const controls = PERIODS.map(
    (days) =>
      `<a class="period-btn${days === periodDays ? " active" : ""}" href="/command-center?period=${days}&week_offset=${weekOffset}">${days === 365 ? "Год" : `${days}д`}</a>`,
  ).join("");
  const previous = `<a class="period-nav" href="/command-center?period=${periodDays}&week_offset=${weekOffset + 1}" aria-label="Предыдущий период">‹</a>`;
  const next =
    weekOffset > 0
      ? `<a class="period-nav" href="/command-center?period=${periodDays}&week_offset=${weekOffset - 1}" aria-label="Следующий период">›</a>`
      : '<span class="period-nav muted">›</span>';
  return `<div class="dashboard-nav__controls"><div class="period-controls">${controls}</div><div class="period-range">${previous}<strong>${shortDateRange(start, end)}</strong>${next}</div></div>`;
}

function metricTotals(posts: NonNullable<PipelineData["posts"]>, targetIds: string[]) {
  return posts.reduce(
    (all, post) => {
      const value = postMetricTotals(post, targetIds);
      all.views += value.views;
      all.likes += value.likes + value.reposts;
      all.replies += value.replies;
      return all;
    },
    { views: 0, likes: 0, replies: 0 },
  );
}

function kpi(label: string, value: number, previous: number): string {
  const percent = previous > 0 ? Math.round(((value - previous) / previous) * 100) : value > 0 ? 100 : 0;
  const direction = percent >= 0 ? "up" : "down";
  const sign = percent >= 0 ? "↑" : "↓";
  return `<div class="kpi"><strong>${formatMetricValue(value)}</strong><span>${label}</span><small class="kpi-delta kpi-delta--${direction}">${sign} ${Math.abs(percent)}% <i>vs прошлый период</i></small></div>`;
}

function shortDateRange(start: Date, end: Date): string {
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  if (start.getUTCMonth() === end.getUTCMonth()) return `${start.getUTCDate()}–${end.getUTCDate()} ${months[end.getUTCMonth()]}`;
  return `${start.getUTCDate()} ${months[start.getUTCMonth()]} – ${end.getUTCDate()} ${months[end.getUTCMonth()]}`;
}

function rollingPeriodDates(offset: number, days: number, timeZone: string): [Date, Date] {
  const shiftedNow = new Date(Date.now() - offset * days * 86_400_000);
  const endParts = zonedDateParts(shiftedNow, timeZone);
  const end = new Date(Date.UTC(endParts.year, endParts.month - 1, endParts.day));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return [start, end];
}
