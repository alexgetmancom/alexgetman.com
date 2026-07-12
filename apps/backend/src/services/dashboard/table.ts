import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey, TOOL_ICON } from "./assets.js";
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

export function renderPipelineTable(posts: PipelinePost[]): string {
  const targetHeaders = renderTargetHeaders();
  const totalCols = 6 + ORDERED_TARGETS.length + 1;
  const rows = [...renderDailyRows(posts, totalCols), renderWeekTotal(posts)].join("\n");

  return `
    <div class="table-wrap">
    <table id="pipeline-table" class="show-mv">
      <thead>
        <tr>
          <th colspan="6"></th>
          ${targetHeaders.row1}
          <th></th>
        </tr>
        <tr>
          <th>Post</th>
          <th class="date-col">Date</th>
          <th>RU</th>
          <th>EN</th>
          <th>Media</th>
          <th class="text-center" title="Общие просмотры">&Sigma;</th>
          ${targetHeaders.row2}
          <th class="text-center" title="Repair">${TOOL_ICON}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
  `;
}

function renderTargetHeaders(): { row1: string; row2: string } {
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
    const nextTarget = index + 1 < ORDERED_TARGETS.length ? ORDERED_TARGETS[index + 1] : null;
    if (nextTarget && platformKey(nextTarget.id) === pkey) {
      const label = { x: "X (Twitter)", github: "GitHub", devto: "dev.to" }[pkey] || pkey.charAt(0).toUpperCase() + pkey.slice(1);
      row1Headers.push(`<th colspan="2" class="text-center" title="${label}">${icon}</th>`);
      row2Headers.push(`<th class="text-center">${target.locale.toUpperCase()}</th>`);
      row2Headers.push(`<th class="text-center">${nextTarget.locale.toUpperCase()}</th>`);
      index += 2;
    } else {
      row1Headers.push(`<th class="text-center" title="${target.label}">${icon}</th>`);
      row2Headers.push("<th></th>");
      index += 1;
    }
  }
  return { row1: row1Headers.join(""), row2: row2Headers.join("") };
}

function renderDailyRows(posts: PipelinePost[], totalCols: number): string[] {
  const rows: string[] = [];
  const sortedDays = Object.entries(groupPostsByMskDay(posts)).sort((a, b) => b[0].localeCompare(a[0]));
  for (const [, dayInfo] of sortedDays) {
    rows.push(`<tr class="day-separator"><td colspan="${totalCols}"><span class="day-label">${dayInfo.dayTitle}</span></td></tr>`);
    rows.push(...dayInfo.posts.map(renderPostRow));
    rows.push(renderTotalsRow(['<td colspan="4"></td>', "<td></td>"], aggregatePosts(dayInfo.posts), "day-header"));
  }
  return rows;
}

function groupPostsByMskDay(posts: PipelinePost[]): Record<string, DayBucket> {
  const days: Record<string, DayBucket> = {};
  for (const post of posts) {
    const date = new Date(post.date ?? "");
    if (Number.isNaN(date.getTime())) continue;
    const msk = new Date(date.getTime() + 3 * 3_600_000);
    const dayStr = msk.toISOString().slice(0, 10);
    days[dayStr] ??= { dayTitle: formatDayHeaderRu(msk), posts: [] };
    days[dayStr].posts.push(post);
  }
  return days;
}

function renderPostRow(post: PipelinePost): string {
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
    ORDERED_TARGETS.map((target) => `<td class="text-center">${targetCell(post, target.id)}</td>`).join("") +
    `<td class="text-center"><a href="/command-center?tab=repair&ref=${escapeHtml(post.post_id || post.message_id || "")}&message_id=${escapeHtml(post.telegram_message_id || "")}" title="Repair">${TOOL_ICON}</a></td>` +
    `</tr>`
  );
}

function renderWeekTotal(posts: PipelinePost[]): string {
  return renderTotalsRow(['<td colspan="4"><b>Итого за неделю</b></td>', "<td></td>"], aggregatePosts(posts), "week-total");
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
): string {
  const cols = [...prefixCols, `<td class="text-center font-bold">${renderMetricSet(aggregate.totals)}</td>`];
  for (const target of ORDERED_TARGETS) {
    const cell =
      renderMetricSpan(aggregate.byTarget.views[target.id] || 0, "mv") +
      renderMetricSpan(aggregate.byTarget.likes[target.id] || 0, "ml") +
      renderMetricSpan(aggregate.byTarget.replies[target.id] || 0, "mr") +
      renderMetricSpan(aggregate.byTarget.reposts[target.id] || 0, "mp");
    cols.push(`<td class="text-center font-bold">${cell}</td>`);
  }
  cols.push("<td></td>");
  return `<tr class="${className}">${cols.join("")}</tr>`;
}
