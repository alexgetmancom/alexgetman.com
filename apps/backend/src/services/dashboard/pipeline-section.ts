import { renderWeeklyChart } from "./chart.js";
import { formatDayHeaderRu, getWeekBounds, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import { renderPipelineTable } from "./table.js";
import type { PipelineData } from "./types.js";

export { shortPipelineText };

export function renderPipelineSection(weekOffset: number, data: PipelineData | null): string {
  const [startOfWeek, endOfWeek] = getWeekBounds(weekOffset);
  const weekStartStr = formatDayHeaderRu(startOfWeek);
  const weekEndStr = formatDayHeaderRu(endOfWeek);
  const posts = data?.posts ?? [];
  const nextBtn =
    weekOffset > 0
      ? `<a class="pag-btn" href="/command-center?tab=pipeline&week_offset=${weekOffset - 1}">Следующая неделя &rarr;</a>`
      : '<span class="pag-btn disabled">Следующая неделя &rarr;</span>';
  const currentBtn = weekOffset > 0 ? `<a class="pag-btn" href="/command-center?tab=pipeline&week_offset=0">Текущая неделя</a>` : "";
  const prevBtn = `<a class="pag-btn" href="/command-center?tab=pipeline&week_offset=${weekOffset + 1}">&larr; Предыдущая неделя</a>`;
  const processedCount = data?.social_worker?.processed_count ?? 0;
  const lastUpdateId = data?.social_worker?.last_update_id ?? "n/a";
  const updatedTime = data?.updated_at ?? new Date().toISOString();

  return `
    <section style="margin-top: 0;">
      <div class="pagination-bar">
        ${prevBtn}
        ${currentBtn}
        <span class="pag-current">${weekStartStr} &ndash; ${weekEndStr}</span>
        ${nextBtn}
      </div>
      <div class="metric-dashboard">
        <div class="metric-toggle metric-toggle--vertical" id="metric-toggle">
          <button class="mt-btn mt-active" type="button" data-m="mv">👁 Views</button>
          <button class="mt-btn" type="button" data-m="ml">❤️ Likes</button>
          <button class="mt-btn" type="button" data-m="mr">💬 Replies</button>
        </div>
        ${renderWeeklyChart(posts)}
      </div>
      ${renderPipelineTable(posts)}
      <p class="note">
        Feed: ${data?.feed?.items ?? 0} | 
        Processed: ${processedCount} | 
        Last update: ${escapeHtml(lastUpdateId)} | 
        JSON: <a href="/api/pipeline-status?week_offset=${weekOffset}">/api/pipeline-status</a> | 
        Updated: ${escapeHtml(updatedTime)}
      </p>
    </section>
  `;
}
