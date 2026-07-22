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
      return `<span><i style="background:${colors[metric]}"></i>${metric}: ${formatMetricValue(sum)}</span>`;
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
