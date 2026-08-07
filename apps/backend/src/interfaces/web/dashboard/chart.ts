import { escapeHtml } from "../../../foundation/html.js";
import { formatMetricValue } from "./format.js";

/** Compact daily bars for the editorial overview. */
export const OVERVIEW_SPARK_MAX = 50_000;

export function renderOverviewSparkline(
  points: Array<{ label: string; value: number }>,
  color: string,
  ariaLabel: string,
  leftLabel: string,
  rightLabel: string,
): string {
  if (!points.length) return "";

  const width = 560;
  const height = 58;
  const barGap = 3;
  const barWidth = (width - (points.length - 1) * barGap) / points.length;
  const values = points.map((point) => Math.max(0, point.value));
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  const clippedAverage = Math.min(OVERVIEW_SPARK_MAX, average);
  const averageY = height - (clippedAverage / OVERVIEW_SPARK_MAX) * height;
  const bars = points
    .map((point, index) => {
      const value = values[index] ?? 0;
      const overCap = value > OVERVIEW_SPARK_MAX;
      const visibleValue = Math.min(value, OVERVIEW_SPARK_MAX);
      const barHeight = Math.max(1, (visibleValue / OVERVIEW_SPARK_MAX) * height);
      const x = index * (barWidth + barGap);
      const y = height - barHeight;
      const opacity = overCap
        ? 1
        : index === points.length - 1
          ? 1
          : Math.max(0.24, 0.72 - ((points.length - 1 - index) / Math.max(1, points.length)) * 0.35);
      const barClass = `overview-spark__bar${overCap ? " overview-spark__bar--over-cap" : ""}`;
      const tooltip = `${escapeHtml(point.label)} · ${formatMetricValue(value)}`;
      return `<g><rect class="${barClass}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2" fill="${color}" opacity="${opacity.toFixed(2)}"/><rect class="chart-hit" x="${Math.max(0, x - barGap / 2).toFixed(2)}" y="0" width="${(barWidth + barGap).toFixed(2)}" height="${height}" data-tooltip="${tooltip}"/></g>`;
    })
    .join("");

  return `<div class="overview-spark">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(ariaLabel)}">
      <line class="overview-spark__cap" x1="0" y1="0" x2="${width}" y2="0"/>
      <text class="overview-spark__cap-label" x="${width}" y="9" text-anchor="end">50k</text>
      <line class="overview-spark__average" x1="0" y1="${averageY.toFixed(2)}" x2="${width}" y2="${averageY.toFixed(2)}"/>
      ${bars}
    </svg>
    <div class="overview-spark__footer"><span>${escapeHtml(leftLabel)}</span><span>среднее <b>${formatMetricValue(Math.round(average))}</b> · ${escapeHtml(rightLabel)} <b>${formatMetricValue(points.at(-1)?.value ?? 0)}</b></span></div>
  </div>`;
}
