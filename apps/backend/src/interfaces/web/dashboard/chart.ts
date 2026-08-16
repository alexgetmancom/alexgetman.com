import { escapeHtml } from "../../../foundation/html.js";
import { t } from "../../../foundation/i18n/index.js";
import type { StudioLocale } from "../../../foundation/locale.js";
import { formatMetricValue } from "./format.js";

/** Compact daily bars for the editorial overview.
 *
 * The ceiling follows the data: a fixed one drew a young studio's whole month as
 * a flat line at the bottom, and clipped a grown one's best days. It is rounded
 * up to a readable step so the dashed cap line can carry a number. */
function sparkCeiling(peak: number): number {
  if (!(peak > 0)) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const step = [1, 1.5, 2, 2.5, 5, 10].find((candidate) => peak <= candidate * magnitude) ?? 10;
  return step * magnitude;
}

/**
 * `fresh` is the part of `value` earned by publications of that same day, drawn
 * as a darker foot of the bar. `partial` marks a day still in progress, whose
 * bar is short because the day is, not because the day is bad.
 */
export type OverviewSparkPoint = { label: string; value: number; fresh?: number; partial?: boolean };

export function renderOverviewSparkline(
  points: OverviewSparkPoint[],
  color: string,
  ariaLabel: string,
  leftLabel: string,
  rightLabel: string,
  locale: StudioLocale,
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
      const barClass = `overview-spark__bar${overCap ? " overview-spark__bar--over-cap" : ""}${point.partial ? " overview-spark__bar--partial" : ""}`;
      const fresh = Math.max(0, point.fresh ?? 0);
      // The cap clips how tall the segment is drawn, never what it reports.
      const freshHeight = fresh > 0 ? Math.min(barHeight, Math.max(1, (Math.min(fresh, visibleValue) / OVERVIEW_SPARK_MAX) * height)) : 0;
      const cohort =
        freshHeight > 0
          ? `<rect class="overview-spark__bar overview-spark__bar--fresh" x="${x.toFixed(2)}" y="${(height - freshHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${freshHeight.toFixed(2)}" rx="2" fill="${color}" opacity="${Math.min(1, opacity + 0.34).toFixed(2)}"/>${
              barHeight - freshHeight > 1.5
                ? `<line class="overview-spark__cohort" x1="${x.toFixed(2)}" y1="${(height - freshHeight).toFixed(2)}" x2="${(x + barWidth).toFixed(2)}" y2="${(height - freshHeight).toFixed(2)}"/>`
                : ""
            }`
          : "";
      const tooltip = escapeHtml(
        [
          `${point.label} · ${formatMetricValue(value)}`,
          fresh > 0 ? `${t(locale, "cc.overview.new")} ${formatMetricValue(fresh)}` : "",
          point.partial ? t(locale, "cc.overview.partial-day") : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      return `<g><rect class="${barClass}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2" fill="${color}" opacity="${opacity.toFixed(2)}"/>${cohort}<rect class="chart-hit" x="${Math.max(0, x - barGap / 2).toFixed(2)}" y="0" width="${(barWidth + barGap).toFixed(2)}" height="${height}" data-tooltip="${tooltip}"/></g>`;
    })
    .join("");

  return `<div class="overview-spark">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(ariaLabel)}">
      <line class="overview-spark__cap" x1="0" y1="0" x2="${width}" y2="0"/>
      <text class="overview-spark__cap-label" x="${width}" y="9" text-anchor="end">50k</text>
      <line class="overview-spark__average" x1="0" y1="${averageY.toFixed(2)}" x2="${width}" y2="${averageY.toFixed(2)}"/>
      ${bars}
    </svg>
    <div class="overview-spark__footer"><span>${escapeHtml(leftLabel)}</span><span>${t(locale, "cc.overview.average")} <b>${formatMetricValue(Math.round(average))}</b> · ${escapeHtml(rightLabel)} <b>${formatMetricValue(points.at(-1)?.value ?? 0)}</b></span></div>
  </div>`;
}
