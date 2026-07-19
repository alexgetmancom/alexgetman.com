import { zonedDateParts } from "../../foundation/time.js";
import { platformGroupLabel } from "../../publishing/platform-profiles.js";
import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey } from "./assets.js";
import { formatDayHeaderRu, formatTimeMsk, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import {
  DASHBOARD_METRICS,
  emptyTargetMetrics,
  emptyTotals,
  formatMedia,
  getTargetMetric,
  postMetricTotals,
  renderMetricSet,
  renderMetricSpan,
  targetCell,
} from "./metrics.js";
import type { DashboardMetricName, PipelinePost } from "./types.js";

type DayBucket = { dayTitle: string; posts: PipelinePost[] };

// The weekly pipeline table buckets by Moscow calendar day regardless of the
// Studio's configured display timezone; this is a business-cadence choice,
// not a display preference (see schedule.ts's SCHEDULE_TIMEZONE).
const PIPELINE_TIMEZONE = "Europe/Moscow";

export function renderPipelineTable(posts: PipelinePost[]): string {
  const compactPlatforms = new Set(
    ORDERED_TARGETS.filter((target) => !hasAnyMetric(posts, target.id)).map((target) => platformKey(target.id)),
  );
  const targetHeaders = renderTargetHeaders(compactPlatforms);
  const totalCols = 6 + ORDERED_TARGETS.length;
  const rows = [...renderDailyRows(posts, totalCols, compactPlatforms), renderWeekTotal(posts, compactPlatforms)].join("\n");
  const hiddenPlatforms = [...compactPlatforms].length;

  return `
    ${hiddenPlatforms ? `<details class="pipeline-target-details"><summary>Показать ещё ${hiddenPlatforms} площадок без метрик</summary></details>` : ""}
    <div class="table-wrap">
    <table id="pipeline-table" class="show-mv${hiddenPlatforms ? " pipeline-compact-targets" : ""}">
      <thead>
        <tr>
          <th colspan="6"></th>
          ${targetHeaders.row1}
        </tr>
        <tr>
          <th>Post</th>
          <th class="date-col">Date</th>
          <th>RU</th>
          <th>EN</th>
          <th>Media</th>
          <th class="text-center" title="Общие просмотры">&Sigma;</th>
          ${targetHeaders.row2}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  `;
}

function renderTargetHeaders(compactPlatforms: Set<string>): { row1: string; row2: string } {
  const row1Headers: string[] = [];
  const row2Headers: string[] = [];
  let index = 0;
  while (index < ORDERED_TARGETS.length) {
    const target = ORDERED_TARGETS[index];
    if (!target) {
      index += 1;
      continue;
    }
    const pkey = platformKey(target.id);
    const icon = PLATFORM_ICONS[pkey] || "";
    const compactClass = compactPlatforms.has(pkey) ? " secondary-target" : "";
    const nextTarget = index + 1 < ORDERED_TARGETS.length ? ORDERED_TARGETS[index + 1] : null;
    if (nextTarget && platformKey(nextTarget.id) === pkey) {
      const label = platformGroupLabel(pkey);
      row1Headers.push(`<th colspan="2" class="text-center secondary-group${compactClass}" title="${label}">${icon}</th>`);
      row2Headers.push(`<th class="text-center${compactClass}">${target.locale.toUpperCase()}</th>`);
      row2Headers.push(`<th class="text-center${compactClass}">${nextTarget.locale.toUpperCase()}</th>`);
      index += 2;
    } else {
      row1Headers.push(`<th class="text-center${compactClass}" title="${target.label}">${icon}</th>`);
      row2Headers.push(`<th class="${compactClass.trim()}"></th>`);
      index += 1;
    }
  }
  return { row1: row1Headers.join(""), row2: row2Headers.join("") };
}

function renderDailyRows(posts: PipelinePost[], totalCols: number, compactPlatforms: Set<string>): string[] {
  const rows: string[] = [];
  const sortedDays = Object.entries(groupPostsByMskDay(posts)).sort((a, b) => b[0].localeCompare(a[0]));
  for (const [, dayInfo] of sortedDays) {
    rows.push(`<tr class="day-separator"><td colspan="${totalCols}"><span class="day-label">${dayInfo.dayTitle}</span></td></tr>`);
    rows.push(...dayInfo.posts.map((post) => renderPostRow(post, compactPlatforms)));
    rows.push(renderTotalsRow(['<td colspan="4"></td>', "<td></td>"], aggregatePosts(dayInfo.posts), "day-header", compactPlatforms));
  }
  return rows;
}

function groupPostsByMskDay(posts: PipelinePost[]): Record<string, DayBucket> {
  const days: Record<string, DayBucket> = {};
  for (const post of posts) {
    const date = new Date(post.date ?? "");
    if (Number.isNaN(date.getTime())) continue;
    const { year, month, day } = zonedDateParts(date, PIPELINE_TIMEZONE);
    const dayStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    days[dayStr] ??= { dayTitle: formatDayHeaderRu(new Date(Date.UTC(year, month - 1, day))), posts: [] };
    days[dayStr].posts.push(post);
  }
  return days;
}

function renderPostRow(post: PipelinePost, compactPlatforms: Set<string>): string {
  const timeStr = formatTimeMsk(post.date);
  const displayId = escapeHtml(post.post_id || post.message_id || "");
  const postLink = post.site_url ? `<a href="${escapeHtml(post.site_url)}">${displayId}</a>` : displayId;
  const targetIds = ORDERED_TARGETS.map((target) => target.id);
  const sigma = renderMetricSet(postMetricTotals(post, targetIds));
  const ruText = post.text_ru || "";
  const enText = post.text_en || "";

  return (
    `<tr>` +
    `<td>${postLink}</td>` +
    `<td class="nowrap date-col text-center">${timeStr}</td>` +
    `<td class="post-text" title="${escapeHtml(ruText)}">${escapeHtml(shortPipelineText(ruText, 7))}</td>` +
    `<td class="post-text" title="${escapeHtml(enText)}">${escapeHtml(shortPipelineText(enText, 7))}</td>` +
    `<td>${escapeHtml(formatMedia(post))}</td>` +
    `<td class="text-center nowrap font-bold">${sigma}</td>` +
    ORDERED_TARGETS.map(
      (target) =>
        `<td class="text-center${compactPlatforms.has(platformKey(target.id)) ? " secondary-target" : ""}">${targetCell(post, target.id)}</td>`,
    ).join("") +
    `</tr>`
  );
}

function renderWeekTotal(posts: PipelinePost[], compactPlatforms: Set<string>): string {
  return renderTotalsRow(
    ['<td colspan="4"><b>Итого за неделю</b></td>', "<td></td>"],
    aggregatePosts(posts),
    "week-total",
    compactPlatforms,
  );
}

function aggregatePosts(posts: PipelinePost[]): {
  totals: Record<DashboardMetricName, number>;
  byTarget: Record<DashboardMetricName, Record<string, number>>;
} {
  const byTarget = emptyTargetMetrics();
  const totals = emptyTotals();
  for (const target of ORDERED_TARGETS) {
    for (const metric of DASHBOARD_METRICS) byTarget[metric][target.id] = 0;
  }
  for (const post of posts) {
    for (const target of ORDERED_TARGETS) {
      for (const metric of DASHBOARD_METRICS) {
        const value = getTargetMetric(post, target.id, metric);
        byTarget[metric][target.id] = (byTarget[metric][target.id] || 0) + value;
        totals[metric] += value;
      }
    }
  }
  return { totals, byTarget };
}

function renderTotalsRow(
  prefixCols: string[],
  aggregate: { totals: Record<DashboardMetricName, number>; byTarget: Record<DashboardMetricName, Record<string, number>> },
  className: string,
  compactPlatforms: Set<string>,
): string {
  const cols = [...prefixCols, `<td class="text-center font-bold">${renderMetricSet(aggregate.totals)}</td>`];
  for (const target of ORDERED_TARGETS) {
    const cell =
      renderMetricSpan(aggregate.byTarget.views[target.id] || 0, "mv") +
      renderMetricSpan(aggregate.byTarget.likes[target.id] || 0, "ml") +
      renderMetricSpan(aggregate.byTarget.replies[target.id] || 0, "mr") +
      renderMetricSpan(aggregate.byTarget.reposts[target.id] || 0, "mp");
    cols.push(`<td class="text-center font-bold${compactPlatforms.has(platformKey(target.id)) ? " secondary-target" : ""}">${cell}</td>`);
  }
  return `<tr class="${className}">${cols.join("")}</tr>`;
}

function hasAnyMetric(posts: PipelinePost[], targetId: string): boolean {
  return posts.some((post) =>
    Object.values(post.metrics?.[targetId] ?? {}).some((metric) => metric?.value !== undefined && metric?.value !== null),
  );
}
