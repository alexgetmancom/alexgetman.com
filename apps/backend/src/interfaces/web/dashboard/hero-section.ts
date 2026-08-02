import { formatMetricValue } from "./format.js";
import { escapeHtml } from "./html.js";

export type TextHeroMetrics = {
  postCount: number;
  views: number;
  medianViews: number | null;
  reactions: number;
  replies: number;
  reposts: number;
  engagementRate: number | null;
};

export type VideoHeroMetrics = {
  videoCount: number;
  views: number;
  medianViews: number | null;
  completionRate: number | null;
  averageWatchTimeMs: number | null;
  subscribers: number | null;
};

export type HeroSectionInput = {
  text: TextHeroMetrics;
  video: VideoHeroMetrics;
  showText: boolean;
  showVideo: boolean;
};

export function renderHeroSection(input: HeroSectionInput): string {
  return `<section class="hero-metrics">
    ${input.showText ? renderTextCard(input.text) : ""}
    ${input.showVideo ? renderVideoCard(input.video) : ""}
  </section>`;
}

function renderTextCard(metrics: TextHeroMetrics): string {
  return `<article class="hero-card hero-card--text" aria-label="Текстовые метрики">
    ${renderCardHeading("ТЕКСТ", formatCount(metrics.postCount, "пост", "поста", "постов"), "var(--series-text)")}
    ${renderPrimaryMetric(metrics.views, metrics.medianViews)}
    <div class="hero-card__secondary">
      ${renderSecondaryMetric("Реакции", formatMetricValue(metrics.reactions))}
      ${renderSecondaryMetric("Ответы", formatMetricValue(metrics.replies))}
      ${renderSecondaryMetric("Репосты", formatMetricValue(metrics.reposts))}
      ${renderSecondaryMetric("ER", formatRate(metrics.engagementRate))}
    </div>
  </article>`;
}

function renderVideoCard(metrics: VideoHeroMetrics): string {
  return `<article class="hero-card hero-card--video" aria-label="Видео-метрики">
    ${renderCardHeading("ВИДЕО", formatCount(metrics.videoCount, "ролик", "ролика", "роликов"), "var(--series-video)")}
    ${renderPrimaryMetric(metrics.views, metrics.medianViews)}
    <div class="hero-card__secondary">
      ${renderSecondaryMetric("Досмотры", formatPercent(metrics.completionRate))}
      ${renderSecondaryMetric("Ср. время", formatSeconds(metrics.averageWatchTimeMs))}
      ${renderSecondaryMetric("Подписки", formatSigned(metrics.subscribers))}
    </div>
  </article>`;
}

function renderCardHeading(label: string, count: string, color: string): string {
  return `<div class="hero-card__heading"><i style="background:${color}"></i><strong>${escapeHtml(label)}</strong><span>· ${escapeHtml(count)}</span></div>`;
}

function renderPrimaryMetric(value: number, median: number | null): string {
  return `<div class="hero-card__primary">
    <div class="hero-card__views"><span>Просмотры</span><strong>${formatMetricValue(value)}</strong></div>
    <div class="hero-card__median"><span>медиана 30д</span><strong>${formatOptionalMetric(median)}</strong></div>
    <span class="hero-card__delta ${deltaClass(value, median)}">${formatDelta(value, median)}</span>
  </div>`;
}

function renderSecondaryMetric(label: string, value: string): string {
  return `<div class="hero-card__metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatCount(value: number, one: string, few: string, many: string): string {
  const remainder = value % 100;
  const word = remainder >= 11 && remainder <= 14 ? many : value % 10 === 1 ? one : value % 10 >= 2 && value % 10 <= 4 ? few : many;
  return `${formatMetricValue(value)} ${word}`;
}

function formatOptionalMetric(value: number | null): string {
  return value === null ? "—" : formatMetricValue(value);
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function formatSeconds(value: number | null): string {
  return value === null ? "—" : `${(value / 1_000).toFixed(1)} с`;
}

function formatSigned(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${formatMetricValue(Math.abs(value))}`;
}

function formatDelta(value: number, median: number | null): string {
  if (median === null) return "—";
  if (median === 0) return value > 0 ? "+100%" : "0%";
  const delta = Math.round(((value - median) / median) * 100);
  return `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}%`;
}

function deltaClass(value: number, median: number | null): string {
  return median === null || value >= median ? "hero-card__delta--up" : "hero-card__delta--down";
}
