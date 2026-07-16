import { ORDERED_TARGETS } from "./assets.js";
import { formatMetricValue, getMskDateString } from "./format.js";
import { escapeHtml } from "./html.js";
import { getTargetMetric } from "./metrics.js";
import type { ChartMetricName, PipelinePost } from "./types.js";

/** CVD-safe categorical palette validated against the #0d1117 surface. */
export const CHART_COLORS: Record<ChartMetricName, string> = { views: "#3987e5", likes: "#199e70", replies: "#c98500" };

const METRIC_CLASSES: Record<ChartMetricName, string> = { views: "mv", likes: "ml", replies: "mr" };

/** One metric per view: each metric renders in its own group with its own
 * y-scale, and the metric toggle shows exactly one group. Drawing all three on
 * a shared plot with per-metric normalization made line crossings meaningless. */
export function renderWeeklyChart(posts: PipelinePost[]): string {
  const metrics = ["views", "likes", "replies"] as const satisfies readonly ChartMetricName[];

  const days: Record<string, Record<ChartMetricName, number>> = {};
  for (const post of posts) {
    const day = getMskDateString(post.date);
    days[day] ??= { views: 0, likes: 0, replies: 0 };
    for (const target of ORDERED_TARGETS) {
      for (const metric of metrics) days[day][metric] += getTargetMetric(post, target.id, metric);
    }
  }

  const ordered = Object.entries(days).sort((a, b) => a[0].localeCompare(b[0]));
  if (ordered.length === 0) return "";

  const width = 980;
  const height = 138;
  const left = 46;
  const right = 18;
  const top = 14;
  const bottom = 24;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const maxByMetric = {
    views: Math.max(...ordered.map(([, bucket]) => bucket.views), 1),
    likes: Math.max(...ordered.map(([, bucket]) => bucket.likes), 1),
    replies: Math.max(...ordered.map(([, bucket]) => bucket.replies), 1),
  };

  const point = (index: number, metric: ChartMetricName, value: number): [number, number] => [
    left + (plotW * index) / Math.max(1, ordered.length - 1),
    top + plotH - (plotH * value) / maxByMetric[metric],
  ];

  let grid = "";
  for (let i = 0; i < 5; i++) {
    const y = top + (plotH * i) / 4;
    grid += `<line x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}" class="chart-grid" />`;
  }

  const groups: string[] = [];
  for (const metric of metrics) {
    const color = CHART_COLORS[metric];
    const metricPoints: string[] = [];
    const marks: string[] = [];
    ordered.forEach(([day, bucket], index) => {
      const [x, y] = point(index, metric, bucket[metric]);
      metricPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      const dayValues = metrics.map((item) => `${item}: ${formatMetricValue(bucket[item])}`).join(" · ");
      marks.push(
        `<circle class="chart-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="${color}" />` +
          `<circle class="chart-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" data-tooltip="${escapeHtml(`${day.slice(5)} · ${dayValues}`)}" />`,
      );
    });
    const baseline = (top + plotH).toFixed(1);
    const area =
      ordered.length > 1
        ? `<polygon fill="${color}" fill-opacity="0.08" points="${metricPoints.join(" ")} ${point(ordered.length - 1, metric, 0)[0].toFixed(1)},${baseline} ${left},${baseline}" />`
        : "";
    const axis = [maxByMetric[metric], maxByMetric[metric] / 2, 0]
      .map(
        (value, index) =>
          `<text x="${left - 7}" y="${(top + (plotH * index) / 2 + 4).toFixed(1)}" text-anchor="end">${formatMetricValue(Math.round(value))}</text>`,
      )
      .join("");
    groups.push(
      `<g class="cm cm-${METRIC_CLASSES[metric]}">${area}<polyline class="chart-line" points="${metricPoints.join(" ")}" fill="none" stroke="${color}" stroke-width="2.2" />${axis}${marks.join("")}</g>`,
    );
  }

  const xLabels = ordered
    .map(([day], index) => {
      const [x] = point(index, "views", 0);
      return `<text x="${x.toFixed(1)}" y="${height - 7}" text-anchor="middle">${escapeHtml(day.slice(5))}</text>`;
    })
    .join("");
  const legend = metrics
    .map((metric) => {
      const sum = ordered.reduce((acc, [, bucket]) => acc + bucket[metric], 0);
      return `<span><i style="background:${CHART_COLORS[metric]}"></i>${metric}: ${formatMetricValue(sum)}</span>`;
    })
    .join("");

  return `
    <div class="metric-chart show-mv" id="weekly-chart">
      <div class="metric-chart__legend">${legend}</div>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly metrics chart">${grid}${groups.join("")}${xLabels}</svg>
      <div class="chart-tooltip" id="chart-tooltip" hidden></div>
    </div>
  `;
}
