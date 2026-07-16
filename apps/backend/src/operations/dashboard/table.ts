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

const METRIC_BAR_CLASSES: Record<DashboardMetricName, string> = { views: "mv", likes: "ml", replies: "mr", reposts: "mp" };

export function renderPipelineTable(posts: PipelinePost[]): string {
  const compactPlatforms = new Set(
    ORDERED_TARGETS.filter((target) => !hasAnyMetric(posts, target.id)).map((target) => platformKey(target.id)),
  );
  const targetIds = ORDERED_TARGETS.map((target) => target.id);
  const totalsByPost = new Map(posts.map((post) => [post, postMetricTotals(post, targetIds)]));
  const maxTotals = emptyTotals();
  for (const totals of totalsByPost.values()) {
    for (const metric of DASHBOARD_METRICS) maxTotals[metric] = Math.max(maxTotals[metric], totals[metric]);
  }
  let bestPost: PipelinePost | null = null;
  for (const [post, totals] of totalsByPost) {
    if (totals.views > 0 && (!bestPost || totals.views > (totalsByPost.get(bestPost)?.views ?? 0))) bestPost = post;
  }
  const targetHeaders = renderTargetHeaders(compactPlatforms);
  const totalCols = 7 + ORDERED_TARGETS.length;
  const rows = [
    ...renderDailyRows(posts, totalCols, compactPlatforms, totalsByPost, maxTotals, bestPost),
    renderWeekTotal(posts, compactPlatforms),
  ].join("\n");
  const hiddenPlatforms = [...compactPlatforms].length;

  return `
    ${hiddenPlatforms ? `<details class="pipeline-target-details"><summary>Показать ещё ${hiddenPlatforms} площадок без метрик</summary></details>` : ""}
    <div class="table-wrap">
    <table id="pipeline-table" class="show-mv${hiddenPlatforms ? " pipeline-compact-targets" : ""}">
      <thead>
        <tr>
          <th colspan="7"></th>
          ${targetHeaders.row1}
        </tr>
        <tr>
          <th>Post</th>
          <th class="date-col">Date</th>
          <th>RU</th>
          <th>EN</th>
          <th>Media</th>
          <th class="text-center" title="Общие просмотры">&Sigma;</th>
          <th class="text-center" title="Engagement rate: (лайки + ответы + репосты) / просмотры">ER</th>
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
      const label = { x: "X (Twitter)", github: "GitHub", devto: "dev.to" }[pkey] || pkey.charAt(0).toUpperCase() + pkey.slice(1);
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

function renderDailyRows(
  posts: PipelinePost[],
  totalCols: number,
  compactPlatforms: Set<string>,
  totalsByPost: Map<PipelinePost, Record<DashboardMetricName, number>>,
  maxTotals: Record<DashboardMetricName, number>,
  bestPost: PipelinePost | null,
): string[] {
  const rows: string[] = [];
  const sortedDays = Object.entries(groupPostsByMskDay(posts)).sort((a, b) => b[0].localeCompare(a[0]));
  for (const [, dayInfo] of sortedDays) {
    rows.push(`<tr class="day-separator"><td colspan="${totalCols}"><span class="day-label">${dayInfo.dayTitle}</span></td></tr>`);
    rows.push(
      ...dayInfo.posts.map((post) =>
        renderPostRow(post, compactPlatforms, totalsByPost.get(post) ?? emptyTotals(), maxTotals, post === bestPost),
      ),
    );
    rows.push(renderTotalsRow(['<td colspan="4"></td>', "<td></td>"], aggregatePosts(dayInfo.posts), "day-header", compactPlatforms));
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

function renderPostRow(
  post: PipelinePost,
  compactPlatforms: Set<string>,
  totals: Record<DashboardMetricName, number>,
  maxTotals: Record<DashboardMetricName, number>,
  isBest: boolean,
): string {
  const timeStr = formatTimeMsk(post.date);
  const displayId = escapeHtml(post.post_id || post.message_id || "");
  const postLink = post.site_url ? `<a href="${escapeHtml(post.site_url)}">${displayId}</a>` : displayId;
  const sigma = renderMetricSet(totals);
  const bars = DASHBOARD_METRICS.map((metric) => {
    const max = maxTotals[metric];
    if (!max) return "";
    const pct = Math.round((totals[metric] / max) * 100);
    return `<div class="sigma-bar ${METRIC_BAR_CLASSES[metric]}"><i style="width:${pct}%"></i></div>`;
  }).join("");
  const badge = isBest ? '<span class="best-badge" title="Лучший пост недели по просмотрам">★</span> ' : "";
  const ruText = post.text_ru || "";
  const enText = post.text_en || "";

  return (
    `<tr${isBest ? ' class="best-post"' : ""}>` +
    `<td>${badge}${postLink}</td>` +
    `<td class="nowrap date-col text-center">${timeStr}</td>` +
    `<td class="post-text" title="${escapeHtml(ruText)}">${escapeHtml(shortPipelineText(ruText, 7))}</td>` +
    `<td class="post-text" title="${escapeHtml(enText)}">${escapeHtml(shortPipelineText(enText, 7))}</td>` +
    `<td>${escapeHtml(formatMedia(post))}</td>` +
    `<td class="text-center nowrap font-bold">${sigma}${bars}</td>` +
    `<td class="text-center er-col">${erLabel(totals)}</td>` +
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
  const cols = [
    ...prefixCols,
    `<td class="text-center font-bold">${renderMetricSet(aggregate.totals)}</td>`,
    `<td class="text-center er-col font-bold">${erLabel(aggregate.totals)}</td>`,
  ];
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

function erLabel(totals: Record<DashboardMetricName, number>): string {
  if (!totals.views) return '<span class="dim">—</span>';
  return `${(((totals.likes + totals.replies + totals.reposts) / totals.views) * 100).toFixed(1)}%`;
}

function hasAnyMetric(posts: PipelinePost[], targetId: string): boolean {
  return posts.some((post) =>
    Object.values(post.metrics?.[targetId] ?? {}).some((metric) => metric?.value !== undefined && metric?.value !== null),
  );
}
