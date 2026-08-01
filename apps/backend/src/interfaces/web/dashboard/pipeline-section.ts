import { zonedDateParts } from "../../../foundation/time.js";
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
  options: { targetIds?: string[]; title?: string } = {},
): string {
  const [startOfPeriod, endOfPeriod] = rollingPeriodDates(weekOffset, periodDays, timeZone);
  const posts = data?.posts ?? [];
  const previousPosts = previousData?.posts ?? [];
  const targetIds = options.targetIds ?? ORDERED_TARGETS.map((target) => target.id);
  const totals = metricTotals(posts, targetIds);
  const previousTotals =
    comparisonDays === 30
      ? medianDailyTotals(previousPosts, targetIds, comparisonDays, timeZone)
      : averageTotals(metricTotals(previousPosts, targetIds), comparisonDays);
  const previousPostCount =
    comparisonDays === 30 ? medianDailyPostCount(previousPosts, comparisonDays, timeZone) : previousPosts.length / comparisonDays;
  const comparisonLabel = comparisonDays === 30 ? "vs медиана за 30д" : "vs прошлый период";
  const chart =
    periodDays === 1
      ? renderDailyComparisonChart(posts, dayComparisonData?.posts ?? [], endOfPeriod, timeZone, new Date(), targetIds)
      : renderWeeklyChart(posts, startOfPeriod, endOfPeriod, targetIds);
  return `
    <section class="pipeline-overview">
      <div class="kpi-row">${kpi("Просмотры", totals.views, previousTotals.views, comparisonLabel)}${kpi("Реакции", totals.likes, previousTotals.likes, comparisonLabel)}${kpi("Ответы", totals.replies, previousTotals.replies, comparisonLabel)}${kpi("Посты", posts.length, previousPostCount, comparisonLabel)}</div>
      <div class="insights-row">${audience}<div class="chart-panel"><div class="section-kicker">${options.title ?? (periodDays === 1 ? "Сегодня и вчера" : "Динамика")}</div>${chart}</div></div>
      ${renderPublicationColumns(posts, targetIds)}
    </section>
  `;
}

/**
 * Period and date, as one quiet cluster on the right edge.
 *
 * The five periods used to sit out as a permanent segmented control, which made
 * a filter that changes maybe twice a day the second-heaviest thing in the
 * header. It collapses to the current choice; the rest are one click away in
 * the menu. The date beside it is a label, not a heading, so it is set at the
 * same weight as the arrows around it.
 */
export function renderPeriodControls(
  weekOffset: number,
  periodDays: number,
  timeZone = "Europe/Moscow",
  view?: string,
  extraQuery = "",
): string {
  const [start, end] = rollingPeriodDates(weekOffset, periodDays, timeZone);
  const viewParam = view ? `&view=${encodeURIComponent(view)}` : "";
  const filterParam = `${viewParam}${extraQuery}`;
  const periodLabel = (days: number) => (days === 365 ? "Год" : `${days}д`);
  const options = PERIODS.map(
    (days) =>
      `<a class="${days === periodDays ? "active" : ""}" href="/command-center?period=${days}&week_offset=${weekOffset}${filterParam}">${periodLabel(days)}</a>`,
  ).join("");
  const previous = `<a class="period-nav" href="/command-center?period=${periodDays}&week_offset=${weekOffset + 1}${filterParam}" aria-label="Предыдущий период">‹</a>`;
  const next =
    weekOffset > 0
      ? `<a class="period-nav" href="/command-center?period=${periodDays}&week_offset=${weekOffset - 1}${filterParam}" aria-label="Следующий период">›</a>`
      : '<span class="period-nav muted">›</span>';
  return `<div class="dashboard-nav__controls"><details class="period-menu"><summary class="period-menu__toggle" aria-label="Период">${periodLabel(periodDays)}<i class="caret">▾</i></summary><div class="period-menu__list">${options}</div></details><div class="period-range">${previous}<span>${shortDateRange(start, end)}</span>${next}</div></div>`;
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
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle];
  if (upper === undefined) return 0;
  if (ordered.length % 2) return upper;
  const lower = ordered[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function calendarKey(value: string | null | undefined, timeZone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

// Convention in this module: every interpolated *text* value is escaped here,
// at the point of interpolation. Only parameters documented as pre-rendered
// markup (`audience`, the chart) are trusted, and they are trusted explicitly.
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function kpi(label: string, value: number, previous: number, comparisonLabel: string): string {
  const percent = previous > 0 ? Math.round(((value - previous) / previous) * 100) : value > 0 ? 100 : 0;
  const direction = percent >= 0 ? "up" : "down";
  const sign = percent >= 0 ? "↑" : "↓";
  return `<div class="kpi"><strong>${formatMetricValue(value)}</strong><span>${escapeHtml(label)}</span><small class="kpi-delta kpi-delta--${direction}">${sign} ${Math.abs(percent)}% <i>${escapeHtml(comparisonLabel)}</i></small></div>`;
}

/** Formats with getUTC* on purpose: `rollingPeriodDates` builds these Dates from
 * already zone-resolved parts via Date.UTC, so UTC *is* the display calendar
 * here. Switching to local getters would silently shift the printed range. */
function shortDateRange(start: Date, end: Date): string {
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  if (start.getTime() === end.getTime()) return `${end.getUTCDate()} ${months[end.getUTCMonth()]}`;
  if (start.getUTCMonth() === end.getUTCMonth()) return `${start.getUTCDate()}–${end.getUTCDate()} ${months[end.getUTCMonth()]}`;
  return `${start.getUTCDate()} ${months[start.getUTCMonth()]} – ${end.getUTCDate()} ${months[end.getUTCMonth()]}`;
}

/** Returns the period bounds as UTC-midnight Dates whose calendar fields already
 * carry `timeZone`'s date. Read them back with getUTC*, never local getters. */
export function rollingPeriodDates(offset: number, days: number, timeZone: string): [Date, Date] {
  const shiftedNow = new Date(Date.now() - offset * days * 86_400_000);
  const endParts = zonedDateParts(shiftedNow, timeZone);
  const end = new Date(Date.UTC(endParts.year, endParts.month - 1, endParts.day));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return [start, end];
}
