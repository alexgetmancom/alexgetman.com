import { escapeHtml } from "../../../foundation/html.js";
import { formatMetricValue } from "./format.js";

type HeroMetric = { value: string; label: string };

export type TextHeroMetrics = {
  postCount: number;
  views: number;
  medianViews: number | null;
  reactions: number;
  replies: number;
  reposts: number;
  engagementRate: number | null;
  countLabel: string;
  normLabel: string;
  contextLabel: string;
  paceLabel: string | null;
  projectionViews: number | null;
  progressPercent: number | null;
};

export type VideoHeroMetrics = {
  videoCount: number;
  views: number;
  medianViews: number | null;
  completionRate: number | null;
  averageWatchTimeMs: number | null;
  subscribers: number | null;
  countLabel: string;
  normLabel: string;
  contextLabel: string;
  paceLabel: string | null;
  projectionViews: number | null;
  progressPercent: number | null;
};

export function renderHeroCard(kind: "text", metrics: TextHeroMetrics): string;
export function renderHeroCard(kind: "video", metrics: VideoHeroMetrics): string;
export function renderHeroCard(kind: "text" | "video", metrics: TextHeroMetrics | VideoHeroMetrics): string {
  const isText = kind === "text";
  const count = metrics.countLabel;
  const label = isText ? "ТЕКСТ" : "ВИДЕО";
  const color = isText ? "var(--series-text)" : "var(--series-video)";
  const ariaLabel = isText ? "Текстовые метрики" : "Видео-метрики";
  const progress = metrics.progressPercent === null ? 0 : Math.min(100, Math.max(0, metrics.progressPercent)) / 100;
  const delta = formatDelta(metrics.views, metrics.medianViews);
  // The rule under the heading is the goal gauge, and it turns green once the
  // norm is passed — the same signal the pace label spells out in words.
  const beatNorm = metrics.progressPercent !== null && metrics.progressPercent >= 100;
  return `<article class="hero-card overview-hero-card hero-card--${kind}" style="--hero-progress:${progress.toFixed(3)}" aria-label="${ariaLabel}">
    <div class="hero-card__heading overview-hero-card__heading${beatNorm ? " overview-hero-card__heading--win" : ""}"><i style="background:${color}"></i><strong>${label}</strong><span>${escapeHtml(count)}</span></div>
    <div class="hero-card__primary overview-hero-card__primary">
      <div class="hero-card__views overview-hero-card__views"><strong>${formatMetricValue(metrics.views)}</strong>${delta ? `<em class="hero-card__delta ${deltaClass(metrics.views, metrics.medianViews)}">${delta}</em>` : ""}</div>
      <div class="hero-card__median overview-hero-card__median"><span>${escapeHtml(metrics.normLabel)} · <b>${formatOptionalMetric(metrics.medianViews)}</b></span></div>
    </div>
    <div class="overview-hero-card__context"><span>${escapeHtml(metrics.contextLabel)}</span>${metrics.paceLabel ? `<span class="overview-hero-card__pace ${metrics.progressPercent !== null && metrics.progressPercent >= 100 ? "overview-hero-card__pace--positive" : ""}">${escapeHtml(metrics.paceLabel)}</span>` : ""}</div>
  </article>`;
}

export function renderHeroMicroMetrics(kind: "text", metrics: TextHeroMetrics): string;
export function renderHeroMicroMetrics(kind: "video", metrics: VideoHeroMetrics): string;
export function renderHeroMicroMetrics(kind: "text" | "video", metrics: TextHeroMetrics | VideoHeroMetrics): string {
  const values: HeroMetric[] =
    kind === "text"
      ? [
          { value: formatMetricValue((metrics as TextHeroMetrics).reactions), label: "реакц." },
          { value: formatMetricValue((metrics as TextHeroMetrics).replies), label: "отв." },
          { value: formatMetricValue((metrics as TextHeroMetrics).reposts), label: "репост." },
          { value: formatRate((metrics as TextHeroMetrics).engagementRate), label: "ER" },
        ]
      : [
          { value: formatCompletionRate((metrics as VideoHeroMetrics).completionRate), label: "досмотры" },
          { value: formatSeconds((metrics as VideoHeroMetrics).averageWatchTimeMs), label: "ср. время" },
          { value: formatSigned((metrics as VideoHeroMetrics).subscribers), label: "подп." },
        ];
  return `<div class="overview-micro">${values.map((item, index) => `${index ? '<span class="overview-micro__separator">·</span>' : ""}<span><b>${escapeHtml(item.value)}</b> ${escapeHtml(item.label)}</span>`).join("")}</div>`;
}

function formatOptionalMetric(value: number | null): string {
  return value === null ? "—" : formatMetricValue(value);
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function formatCompletionRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatSeconds(value: number | null): string {
  return value === null ? "—" : `${(value / 1_000).toFixed(1)}с`;
}

function formatSigned(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${formatMetricValue(Math.abs(value))}`;
}

function formatDelta(value: number, median: number | null): string {
  // A zero for the selected period is incomplete data, not a meaningful
  // performance change. Showing -100% or 0% here creates noise until metrics
  // arrive.
  if (value === 0) return "";
  if (median === null) return "—";
  if (median === 0) return value > 0 ? "+100%" : "0%";
  const delta = Math.round(((value - median) / median) * 100);
  return `${delta >= 0 ? "+" : "−"}${Math.abs(delta)}%`;
}

function deltaClass(value: number, median: number | null): string {
  if (median === null) return "hero-card__delta--flat";
  return value >= median ? "hero-card__delta--up" : "hero-card__delta--down";
}
