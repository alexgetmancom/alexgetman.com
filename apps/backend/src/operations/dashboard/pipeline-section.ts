import { zonedDateParts } from "../../foundation/time.js";
import { ORDERED_TARGETS } from "./assets.js";
import { renderDailyComparisonChart, renderWeeklyChart } from "./chart.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { postMetricTotals } from "./metrics.js";
import { renderPublicationColumns } from "./table.js";
import type { PipelineData } from "./types.js";

export { shortPipelineText };

const PERIODS = [1, 7, 30, 90, 365] as const;

export function renderPipelineSection(
  weekOffset: number,
  periodDays: number,
  data: PipelineData | null,
  previousData: PipelineData | null,
  audience = "",
  timeZone = "Europe/Moscow",
  comparisonDays = periodDays,
  dayComparisonData: PipelineData | null = null,
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
  const previousTotals =
    comparisonDays === 30
      ? medianDailyTotals(previousPosts, targetIds, comparisonDays, timeZone)
      : averageTotals(metricTotals(previousPosts, targetIds), comparisonDays);
  const previousPostCount =
    comparisonDays === 30 ? medianDailyPostCount(previousPosts, comparisonDays, timeZone) : previousPosts.length / comparisonDays;
  const comparisonLabel = comparisonDays === 30 ? "vs медиана за 30д" : "vs прошлый период";
  const chart =
    periodDays === 1
      ? renderDailyComparisonChart(posts, dayComparisonData?.posts ?? [], endOfPeriod, timeZone)
      : renderWeeklyChart(posts, startOfPeriod, endOfPeriod);
  return `
    <section class="pipeline-overview">
      <div class="kpi-row">${kpi("Просмотры", totals.views, previousTotals.views, comparisonLabel)}${kpi("Реакции", totals.likes, previousTotals.likes, comparisonLabel)}${kpi("Ответы", totals.replies, previousTotals.replies, comparisonLabel)}${kpi("Посты", posts.length, previousPostCount, comparisonLabel)}</div>
      <div class="insights-row">${audience}<div class="chart-panel"><div class="section-kicker">${periodDays === 1 ? "Сегодня и вчера" : "Динамика"}</div>${chart}</div></div>
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

function averageTotals(totals: ReturnType<typeof metricTotals>, days: number) {
  if (days <= 1) return totals;
  return { views: totals.views / days, likes: totals.likes / days, replies: totals.replies / days };
}

function medianDailyTotals(posts: NonNullable<PipelineData["posts"]>, targetIds: string[], days: number, timeZone: string) {
  const daily = new Map<string, ReturnType<typeof metricTotals>>();
  for (const post of posts) {
    const date = calendarKey(post.date, timeZone);
    if (!date) return averageTotals(metricTotals(posts, targetIds), days);
    const values = daily.get(date) ?? { views: 0, likes: 0, replies: 0 };
    const value = postMetricTotals(post, targetIds);
    values.views += value.views;
    values.likes += value.likes + value.reposts;
    values.replies += value.replies;
    daily.set(date, values);
  }
  const values = [...daily.values()];
  while (values.length < days) values.push({ views: 0, likes: 0, replies: 0 });
  return {
    views: median(values.map((value) => value.views)),
    likes: median(values.map((value) => value.likes)),
    replies: median(values.map((value) => value.replies)),
  };
}

function medianDailyPostCount(posts: NonNullable<PipelineData["posts"]>, days: number, timeZone: string): number {
  const daily = new Map<string, number>();
  for (const post of posts) {
    const date = calendarKey(post.date, timeZone);
    if (!date) return posts.length / days;
    daily.set(date, (daily.get(date) ?? 0) + 1);
  }
  const values = [...daily.values()];
  while (values.length < days) values.push(0);
  return median(values);
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function calendarKey(value: string | null | undefined, timeZone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function kpi(label: string, value: number, previous: number, comparisonLabel: string): string {
  const percent = previous > 0 ? Math.round(((value - previous) / previous) * 100) : value > 0 ? 100 : 0;
  const direction = percent >= 0 ? "up" : "down";
  const sign = percent >= 0 ? "↑" : "↓";
  return `<div class="kpi"><strong>${formatMetricValue(value)}</strong><span>${label}</span><small class="kpi-delta kpi-delta--${direction}">${sign} ${Math.abs(percent)}% <i>${comparisonLabel}</i></small></div>`;
}

function shortDateRange(start: Date, end: Date): string {
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  if (start.getTime() === end.getTime()) return `${end.getUTCDate()} ${months[end.getUTCMonth()]}`;
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
