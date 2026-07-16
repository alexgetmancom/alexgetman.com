import { jsonArray } from "../../json.js";
import { formatMetricValue } from "./format.js";
import { escapeHtml } from "./html.js";
import { getTargetUrl } from "./target-url.js";
import type { DashboardMetricName, PipelinePost } from "./types.js";

export const DASHBOARD_METRICS = ["views", "likes", "replies", "reposts"] as const satisfies readonly DashboardMetricName[];

function getTargetStatus(post: PipelinePost, target: string): string | null {
  const record = post.targets?.[target];
  if (record?.status && record.status !== "unknown") return record.status;
  if (target === "telegram" && post.telegram_url) return "published";
  if (target === "site_ru" && post.site_ru) return "published";
  if (target === "site_en" && post.site_en) return "published";
  return null;
}

export function getTargetMetric(post: PipelinePost, target: string, metricName: string): number {
  const status = getTargetStatus(post, target);
  if (status !== "published") return 0;
  const val = post.metrics?.[target]?.[metricName]?.value;
  if (val === undefined || val === null) return 0;
  const num = Number(val);
  return Number.isNaN(num) ? 0 : num;
}

function hasTargetMetric(post: PipelinePost, target: string, metricName: string): boolean {
  if ((target === "site_ru" || target === "site_en") && metricName === "views") {
    const botViews = post.metrics?.[target]?.bot_views;
    if (botViews?.value !== undefined && botViews?.value !== null) return true;
  }
  const metric = post.metrics?.[target]?.[metricName];
  return metric?.value !== undefined && metric?.value !== null;
}

export function renderMetricSpan(val: number, className: string): string {
  const text = val > 0 ? formatMetricValue(val) : className === "mv" ? "0" : "—";
  return `<span class="${className}${val > 0 ? "" : " dim"}">${escapeHtml(text)}</span>`;
}

export function renderMetricSet(values: Record<DashboardMetricName, number>): string {
  return (
    renderMetricSpan(values.views, "mv") +
    renderMetricSpan(values.likes, "ml") +
    renderMetricSpan(values.replies, "mr") +
    renderMetricSpan(values.reposts, "mp")
  );
}

export function emptyTargetMetrics(): Record<DashboardMetricName, Record<string, number>> {
  return { views: {}, likes: {}, replies: {}, reposts: {} };
}

export function emptyTotals(): Record<DashboardMetricName, number> {
  return { views: 0, likes: 0, replies: 0, reposts: 0 };
}

export function postMetricTotals(post: PipelinePost, targetIds: string[]): Record<DashboardMetricName, number> {
  const totals = emptyTotals();
  for (const targetId of targetIds) {
    for (const metric of DASHBOARD_METRICS) totals[metric] += getTargetMetric(post, targetId, metric);
  }
  return totals;
}

export function targetCell(post: PipelinePost, target: string): string {
  const status = getTargetStatus(post, target);
  if (status === "publishing" || status === "queued") {
    return '<span class="mv dim">~</span><span class="ml dim">~</span><span class="mr dim">~</span><span class="mp dim">~</span>';
  }
  if (status !== "published") {
    return '<span class="mv dim">—</span><span class="ml dim">—</span><span class="mr dim">—</span><span class="mp dim">—</span>';
  }

  const views =
    getTargetMetric(post, target, "views") +
    (target === "site_ru" || target === "site_en" ? getTargetMetric(post, target, "bot_views") : 0);
  const values = {
    views,
    likes: getTargetMetric(post, target, "likes"),
    replies: getTargetMetric(post, target, "replies"),
    reposts: getTargetMetric(post, target, "reposts"),
  };
  const url = getTargetUrl(post, target);
  const renderSubCell = (value: number, label: string, name: DashboardMetricName) => {
    const hasMetric = hasTargetMetric(post, target, name);
    const text = !hasMetric ? "—" : value > 0 ? formatMetricValue(value) : "0";
    const className = !hasMetric || value <= 0 ? `${label} dim` : label;
    if (url && label === "mv") {
      return `<a class="metric-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span class="${className}">${escapeHtml(text)}</span></a>`;
    }
    return `<span class="${className}">${escapeHtml(text)}</span>`;
  };

  return (
    renderSubCell(values.views, "mv", "views") +
    renderSubCell(values.likes, "ml", "likes") +
    renderSubCell(values.replies, "mr", "replies") +
    renderSubCell(values.reposts, "mp", "reposts")
  );
}

export function formatMedia(post: PipelinePost): string {
  const media = jsonArray(post.media_en_json || post.media_ru_json || post.media_json);
  if (media.length === 0) return "text";
  const hasVideo = media.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return String(record.type ?? record.media_type ?? "").toLowerCase() === "video";
  });
  return `${hasVideo ? "vid" : "pic"} (${media.length})`;
}
