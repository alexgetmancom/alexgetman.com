import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { renderWeeklyChart } from "./chart.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";

type Totals = { views: number; interactions: number; replies: number };
const VISIBLE_RECENT = 5;
const DETAIL_BATCH_SIZE = 10;

export type XPublicationDetailsResult = {
  html: string;
  total: number;
  loaded: number;
  remaining: number;
};

export function renderXSection(
  items: XActivityDashboardItem[],
  previousItems: XActivityDashboardItem[],
  audience: string,
  rangeStart: Date,
  rangeEnd: Date,
  options: { moreUrl?: string } = {},
): string {
  const totals = xTotals(items);
  const previous = xTotals(previousItems);
  const chartPosts = items.map((item) => ({
    post_key: `x:${item.xPostId}`,
    date: item.publishedAt,
    targets: { x: { status: "published" } },
    metrics: {
      x: {
        views: { value: item.metrics.views ?? 0, samples: [] },
        likes: { value: item.metrics.interactions ?? 0, samples: [] },
        replies: { value: item.metrics.replies ?? 0, samples: [] },
      },
    },
  }));
  return `<section class="pipeline-overview">
    <div class="kpi-row">${kpi("Просмотры", totals.views, previous.views)}${kpi("Реакции", totals.interactions, previous.interactions)}${kpi("Ответы", totals.replies, previous.replies)}${kpi("Посты", items.length, previousItems.length)}</div>
    <div class="insights-row">${audience}<div class="chart-panel"><div class="section-kicker">Динамика X</div>${renderWeeklyChart(chartPosts, rangeStart, rangeEnd)}</div></div>
    ${renderXPublicationColumns(items, options)}
  </section>`;
}

function renderXPublicationColumns(items: XActivityDashboardItem[], options: { moreUrl?: string }): string {
  const ranked = [...items].sort((left, right) => metric(right, "views") - metric(left, "views")).slice(0, 3);
  const recent = [...items].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  const lazy = Boolean(options.moreUrl);
  const recentHtml = lazy
    ? recent
        .slice(0, VISIBLE_RECENT)
        .map((item) => renderRecent(item, false))
        .join("")
    : recent.map((item, index) => renderRecent(item, index >= VISIBLE_RECENT)).join("");
  const moreButton =
    recent.length > VISIBLE_RECENT
      ? lazy
        ? `<button class="show-more-posts" type="button" data-more-url="${escapeHtml(options.moreUrl ?? "")}" data-more-offset="${VISIBLE_RECENT}">Показать ещё <span>${recent.length - VISIBLE_RECENT}</span></button>`
        : `<button class="show-more-posts" type="button">Показать ещё <span>${recent.length - VISIBLE_RECENT}</span></button>`
      : "";
  return `<div class="publication-columns">
    <section class="best-posts"><div class="section-kicker">Лучшие публикации</div>${
      ranked.length ? ranked.map(renderBest).join("") : empty()
    }</section>
    <section class="recent-posts">
      <header class="recent-posts__header"><div class="section-kicker">Последние публикации</div><span>Тип</span><span>Охват</span><span>Реакции</span><span>Ответы</span></header>
      ${recent.length ? recentHtml : empty()}
      ${moreButton}
    </section>
  </div>`;
}

export function renderXPublicationDetails(
  items: XActivityDashboardItem[],
  offset = 0,
  limit = DETAIL_BATCH_SIZE,
): XPublicationDetailsResult {
  const recent = [...items].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.min(DETAIL_BATCH_SIZE, Math.floor(limit)));
  const selected = recent.slice(safeOffset, safeOffset + safeLimit);
  return {
    html: selected.map((item) => renderRecent(item, false)).join(""),
    total: recent.length,
    loaded: selected.length,
    remaining: Math.max(0, recent.length - safeOffset - selected.length),
  };
}

function renderBest(item: XActivityDashboardItem, index: number): string {
  return `<a class="best-post" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">
    <span class="post-rank">${index + 1}</span>
    <div class="best-post__copy"><div class="best-post__title">${escapeHtml(shortPipelineText(item.text || "Без текста", 10))}</div></div>
    <div class="best-post__stats"><strong>${formatMetricValue(metric(item, "views"))}</strong><small>просмотры</small><em>♡ ${formatMetricValue(metric(item, "interactions"))}</em></div>
  </a>`;
}

function renderRecent(item: XActivityDashboardItem, hidden: boolean): string {
  return `<details class="post-detail${hidden ? " post-detail--more" : ""}">
    <summary><span class="post-detail__summary">
      <span class="post-detail__headline"><span class="post-detail__chevron">›</span><span class="post-detail__title">${escapeHtml(
        shortPipelineText(item.text || "Без текста", 11),
      )}</span></span>
      <span class="post-detail__media">${kindLabel(item.kind)}</span>
      <span>${formatMetricValue(metric(item, "views"))}</span>
      <span>${formatMetricValue(metric(item, "interactions"))}</span>
      <span>${formatMetricValue(metric(item, "replies"))}</span>
    </span></summary>
    <div class="post-detail__body"><div class="post-detail__content"><div>
      <span class="post-detail__label">${item.linkedPostKey ? `X · ${escapeHtml(item.linkedPostKey)}` : "X ACTIVITY"}</span>
      <p>${escapeHtml(item.text || "Без текста")}</p>
      <a class="metric-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Открыть в X ↗</a>
    </div></div></div>
  </details>`;
}

function xTotals(items: XActivityDashboardItem[]): Totals {
  return items.reduce(
    (totals, item) => ({
      views: totals.views + metric(item, "views"),
      interactions: totals.interactions + metric(item, "interactions"),
      replies: totals.replies + metric(item, "replies"),
    }),
    { views: 0, interactions: 0, replies: 0 },
  );
}

function metric(item: XActivityDashboardItem, name: string): number {
  return Number(item.metrics[name] ?? 0);
}

function kindLabel(kind: XActivityDashboardItem["kind"]): string {
  if (kind === "reply") return "Ответ";
  if (kind === "repost") return "Репост";
  return "Пост";
}

function kpi(label: string, value: number, previous: number): string {
  const percent = previous > 0 ? Math.round(((value - previous) / previous) * 100) : value > 0 ? 100 : 0;
  const direction = percent >= 0 ? "up" : "down";
  return `<div class="kpi"><strong>${formatMetricValue(value)}</strong><span>${escapeHtml(label)}</span><small class="kpi-delta kpi-delta--${direction}">${percent >= 0 ? "↑" : "↓"} ${Math.abs(percent)}%</small></div>`;
}

function empty(): string {
  return '<p class="empty-state">За выбранный период публикаций нет</p>';
}
