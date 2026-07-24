import { zonedSlot } from "../../foundation/time.js";
import { ORDERED_TARGETS } from "./assets.js";
import { formatMetricValue, getMskDateString } from "./format.js";
import { escapeHtml } from "./html.js";
import { getTargetMetric } from "./metrics.js";
import type { ChartMetricName, PipelinePost } from "./types.js";

export function renderWeeklyChart(posts: PipelinePost[], rangeStart?: Date, rangeEnd?: Date): string {
  const metrics = ["views", "likes", "replies"] as const satisfies readonly ChartMetricName[];
  const colors = { views: "#3b8dff", likes: "#ff4e75", replies: "#b7bec9" };
  const labels = { views: "Просмотры", likes: "Реакции", replies: "Ответы" };

  const days: Record<string, Record<ChartMetricName, number>> = {};
  for (const post of posts) {
    const day = getMskDateString(post.date);
    days[day] ??= { views: 0, likes: 0, replies: 0 };
    for (const target of ORDERED_TARGETS) {
      for (const metric of metrics) days[day][metric] += getTargetMetric(post, target.id, metric);
    }
  }

  fillCalendarDays(days, rangeStart, rangeEnd);
  const ordered = Object.entries(days).sort((a, b) => a[0].localeCompare(b[0]));
  if (ordered.length === 0) return "";

  const width = 980;
  const height = 138;
  const left = 42;
  const right = 18;
  const top = 14;
  const bottom = 24;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const boundsByMetric = Object.fromEntries(
    metrics.map((metric) => {
      const values = ordered.map(([, bucket]) => bucket[metric]);
      const min = Math.min(...values);
      const max = Math.max(...values);
      return [metric, { min, span: Math.max(max - min, 1) }];
    }),
  ) as Record<ChartMetricName, { min: number; span: number }>;

  const point = (index: number, metric: ChartMetricName, value: number): [number, number] => [
    left + (plotW * index) / Math.max(1, ordered.length - 1),
    top + plotH - (plotH * (value - boundsByMetric[metric].min)) / boundsByMetric[metric].span,
  ];

  let grid = "";
  for (let i = 0; i < 5; i++) {
    const y = top + (plotH * i) / 4;
    grid += `<line x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}" class="chart-grid" />`;
  }

  const lines: string[] = [];
  const points: string[] = [];
  for (const metric of metrics) {
    const metricPoints: string[] = [];
    ordered.forEach(([day, bucket], index) => {
      const [x, y] = point(index, metric, bucket[metric]);
      metricPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      const dayValues = metrics.map((item) => `${labels[item]}: ${formatMetricValue(bucket[item])}`).join(" · ");
      const tooltip = `${formatDateLabel(day)} · ${dayValues}`;
      points.push(
        `<circle class="chart-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="${colors[metric]}" />` +
          `<circle class="chart-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" data-tooltip="${escapeHtml(tooltip)}" />`,
      );
    });
    lines.push(
      `<polyline class="chart-line" points="${metricPoints.join(" ")}" fill="none" stroke="${colors[metric]}" stroke-width="2.2" />`,
    );
  }

  const xLabels = ordered
    .map(([day], index) => {
      const [x] = point(index, "views", 0);
      return `<text x="${x.toFixed(1)}" y="${height - 7}" text-anchor="middle">${escapeHtml(formatDateLabel(day))}</text>`;
    })
    .join("");
  const legend = metrics
    .map((metric) => {
      const sum = ordered.reduce((acc, [, bucket]) => acc + bucket[metric], 0);
      return `<span><i style="background:${colors[metric]}"></i>${labels[metric]}: ${formatMetricValue(sum)}</span>`;
    })
    .join("");

  return `
    <div class="metric-chart">
      <div class="metric-chart__legend">${legend}</div>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="График метрик за выбранный период">${grid}${lines.join("")}${points.join("")}${xLabels}</svg>
      <div class="chart-tooltip" id="chart-tooltip" hidden></div>
    </div>
  `;
}

/**
 * A one-day view uses immutable collection samples rather than pretending that
 * we know the value for every hour. Both series are clipped to the same wall
 * clock so "today" is directly comparable with "yesterday".
 */
export function renderDailyComparisonChart(
  todayPosts: PipelinePost[],
  yesterdayPosts: PipelinePost[],
  day: Date,
  timeZone: string,
  now = new Date(),
): string {
  const dayStart = zonedSlot(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), "00:00", timeZone);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const yesterdayStart = new Date(dayStart.getTime() - 86_400_000);
  const isToday = now >= dayStart && now < dayEnd;
  const cutoff = isToday ? now : dayEnd;
  const current = sampledViewTimeline(todayPosts, dayStart, cutoff);
  const previous = sampledViewTimeline(
    yesterdayPosts,
    yesterdayStart,
    new Date(yesterdayStart.getTime() + (cutoff.getTime() - dayStart.getTime())),
  );
  if (current.length <= 1 && previous.length <= 1)
    return `<div class="metric-chart metric-chart--empty"><div class="metric-chart__legend"><span>Замеры появятся через час после публикации</span></div></div>`;

  const width = 980;
  const height = 170;
  const left = 18;
  const right = 18;
  const top = 20;
  const bottom = 28;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const max = Math.max(1, ...current.map((point) => point.value), ...previous.map((point) => point.value));
  const x = (at: Date, start: Date) => left + (plotW * (at.getTime() - start.getTime())) / 86_400_000;
  const y = (value: number) => top + plotH - (plotH * value) / max;
  let grid = "";
  for (let i = 0; i < 4; i++) {
    const gridY = top + (plotH * i) / 3;
    grid += `<line x1="${left}" y1="${gridY.toFixed(1)}" x2="${width - right}" y2="${gridY.toFixed(1)}" class="chart-grid" />`;
  }
  const series = [
    { name: "Сегодня", color: "#3b8dff", points: current, start: dayStart },
    { name: "Вчера", color: "#aeb8c8", points: previous, start: yesterdayStart },
  ];
  const paths = series
    .map(
      ({ color, points, start }) =>
        `<polyline class="chart-line" points="${points.map((point) => `${x(point.at, start).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.4" />`,
    )
    .join("");
  const points = series
    .flatMap(({ name, color, points, start }) =>
      points.slice(1).map((point) => {
        const tooltip = `${name}, ${clockLabel(point.at, timeZone)} · ${formatMetricValue(point.value)} просмотров`;
        return `<circle class="chart-point" cx="${x(point.at, start).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="3" fill="${color}" /><circle class="chart-hit" cx="${x(point.at, start).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="10" data-tooltip="${escapeHtml(tooltip)}" />`;
      }),
    )
    .join("");
  const labels = [0, 6, 12, 18, 24]
    .map(
      (hour) =>
        `<text x="${(left + (plotW * hour) / 24).toFixed(1)}" y="${height - 7}" text-anchor="middle">${String(hour).padStart(2, "0")}:00</text>`,
    )
    .join("");
  const currentTotal = current.at(-1)?.value ?? 0;
  const previousTotal = previous.at(-1)?.value ?? 0;
  return `<div class="metric-chart"><div class="metric-chart__legend"><span><i style="background:#3b8dff"></i>Сегодня: ${formatMetricValue(currentTotal)}</span><span><i style="background:#aeb8c8"></i>Вчера к этому времени: ${formatMetricValue(previousTotal)}</span><em>реальные замеры</em></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Сравнение просмотров сегодня и вчера по времени суток">${grid}${paths}${points}${labels}</svg><div class="chart-tooltip" id="chart-tooltip" hidden></div></div>`;
}

type TimelinePoint = { at: Date; value: number };

function sampledViewTimeline(posts: PipelinePost[], start: Date, cutoff: Date): TimelinePoint[] {
  const events: Array<{ at: Date; key: string; value: number }> = [];
  for (const post of posts) {
    for (const [target, metrics] of Object.entries(post.metrics ?? {})) {
      for (const sample of metrics?.views?.samples ?? []) {
        const at = sample.sampled_at ? new Date(sample.sampled_at) : null;
        const value = Number(sample.value);
        if (!at || Number.isNaN(at.getTime()) || !Number.isFinite(value) || at < start || at > cutoff) continue;
        events.push({ at, key: `${post.post_key ?? post.post_id ?? post.date ?? "post"}:${target}`, value });
      }
    }
  }
  events.sort((left, right) => left.at.getTime() - right.at.getTime());
  const latest = new Map<string, number>();
  let total = 0;
  const points: TimelinePoint[] = [{ at: start, value: 0 }];
  for (const event of events) {
    total += event.value - (latest.get(event.key) ?? 0);
    latest.set(event.key, event.value);
    points.push({ at: event.at, value: total });
  }
  return points;
}

function clockLabel(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(value);
}

function fillCalendarDays(days: Record<string, Record<ChartMetricName, number>>, start?: Date, end?: Date): void {
  if (!start || !end) return;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor.getTime() <= last) {
    const key = cursor.toISOString().slice(0, 10);
    days[key] ??= { views: 0, likes: 0, replies: 0 };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function formatDateLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}
