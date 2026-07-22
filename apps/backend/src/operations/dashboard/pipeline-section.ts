import { ORDERED_TARGETS } from "./assets.js";
import { renderWeeklyChart } from "./chart.js";
import { formatDayHeaderRu, formatMetricValue, getWeekBounds, shortPipelineText } from "./format.js";
import { postMetricTotals } from "./metrics.js";
import { renderPublicationColumns } from "./table.js";
import type { PipelineData } from "./types.js";

export { shortPipelineText };

const PERIODS = [7, 30, 90, 365] as const;

export function renderPipelineSection(weekOffset: number, periodDays: number, data: PipelineData | null, audience = ""): string {
  const [startOfWeek, endOfWeek] = getWeekBounds(weekOffset);
  const weekStartStr = formatDayHeaderRu(startOfWeek);
  const weekEndStr = formatDayHeaderRu(endOfWeek);
  const posts = data?.posts ?? [];
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
  const periodLabel = periodDays === 7 ? `${weekStartStr} – ${weekEndStr}` : `${periodDays} дней`;
  const controls = PERIODS.map(
    (days) =>
      `<a class="period-btn${days === periodDays ? " active" : ""}" href="/command-center?period=${days}&week_offset=${weekOffset}">${days === 365 ? "Год" : `${days}д`}</a>`,
  ).join("");
  const previous = `<a class="period-nav" href="/command-center?period=${periodDays}&week_offset=${weekOffset + 1}" aria-label="Предыдущий период">‹</a>`;
  const next =
    weekOffset > 0
      ? `<a class="period-nav" href="/command-center?period=${periodDays}&week_offset=${weekOffset - 1}" aria-label="Следующий период">›</a>`
      : '<span class="period-nav muted">›</span>';

  return `
    <section class="pipeline-overview">
      <header class="overview-toolbar"><div class="period-controls">${controls}</div><div class="period-range">${previous}<strong>${periodLabel}</strong>${next}</div></header>
      <div class="kpi-row"><div><span>Просмотры</span><strong>${formatMetricValue(totals.views)}</strong></div><div><span>Реакции</span><strong>${formatMetricValue(totals.likes)}</strong></div><div><span>Ответы</span><strong>${formatMetricValue(totals.replies)}</strong></div><div><span>Публикации</span><strong>${posts.length}</strong></div></div>
      <div class="insights-row">${audience}<div class="chart-panel"><div class="section-kicker">Динамика</div>${renderWeeklyChart(posts)}</div></div>
      ${renderPublicationColumns(posts)}
    </section>
  `;
}
