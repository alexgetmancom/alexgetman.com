import { ORDERED_TARGETS } from "./assets.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import { formatMedia, postMetricTotals } from "./metrics.js";
import type { PipelinePost } from "./types.js";

const targetIds = ORDERED_TARGETS.map((target) => target.id);

export function renderPublicationColumns(posts: PipelinePost[]): string {
  const ranked = [...posts].sort((left, right) => total(right).views - total(left).views).slice(0, 3);
  return `<div class="publication-columns"><section class="best-posts"><div class="section-kicker">Лучшие публикации</div>${ranked.length ? ranked.map((post, index) => renderBestPost(post, index + 1)).join("") : empty("За выбранный период публикаций нет")}</section><section class="recent-posts"><header class="recent-posts__header"><div class="section-kicker">Последние публикации</div><div class="recent-columns"><span>Тип медиа</span><span>Охват</span><span>Реакции</span><span>Ответы</span></div></header>${posts.length ? posts.slice(0, 5).map(renderRecentPost).join("") : empty("За выбранный период публикаций нет")}</section></div>`;
}

function renderBestPost(post: PipelinePost, rank: number): string {
  const metrics = total(post);
  return `<article class="best-post"><span class="post-rank">${rank}</span><span class="best-post__media">${mediaIcon(post)}</span><div class="best-post__copy"><div class="best-post__title">${escapeHtml(shortPipelineText(post.text_ru || post.text_en || "Без текста", 10))}</div></div><div class="best-post__stats"><strong>${formatMetricValue(metrics.views)}</strong><small>просмотры</small><em>♡ ${formatMetricValue(reactions(metrics))}</em></div></article>`;
}

function renderRecentPost(post: PipelinePost): string {
  const metrics = total(post);
  const english = post.full_text_en || post.text_en || "Без английского текста";
  const russian = post.full_text_ru || post.text_ru || "—";
  return `<details class="post-detail"><summary><span class="post-detail__summary"><span class="post-detail__chevron">›</span><span class="post-detail__title">${escapeHtml(shortPipelineText(english, 11))}</span><span class="post-detail__media">${escapeHtml(mediaLabel(post))}</span><span>${formatMetricValue(metrics.views)}</span><span>${formatMetricValue(reactions(metrics))}</span><span>${formatMetricValue(metrics.replies)}</span></span></summary><div class="post-detail__body"><div><span class="post-detail__label">ENGLISH</span><p>${escapeHtml(english)}</p><span class="post-detail__label">RU ORIGINAL</span><p>${escapeHtml(russian)}</p></div>${mediaPreview(post)}</div></details>`;
}

function mediaPreview(post: PipelinePost): string {
  const media = post.media_en_json ?? post.media_json ?? post.media_ru_json;
  const url = mediaUrl(media);
  if (url)
    return `<a class="post-preview" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(url)}" alt="Превью медиа"></a>`;
  return `<div class="post-preview post-preview--empty">${escapeHtml(mediaLabel(post))}</div>`;
}

function mediaUrl(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || typeof first !== "object") return null;
  const candidate =
    (first as Record<string, unknown>).url ?? (first as Record<string, unknown>).public_url ?? (first as Record<string, unknown>).vps_url;
  return typeof candidate === "string" && (/^https:\/\//.test(candidate) || candidate.startsWith("/")) ? candidate : null;
}

function mediaLabel(post: PipelinePost): string {
  const media = formatMedia(post).toLowerCase();
  if (/(vid|video)/.test(media)) return "Видео";
  if (/(pic|photo|image)/.test(media)) return "Изображение";
  return "Текст";
}

function mediaIcon(post: PipelinePost): string {
  return mediaLabel(post) === "Видео" ? "▻" : mediaLabel(post) === "Изображение" ? "▧" : "¶";
}

function total(post: PipelinePost) {
  return postMetricTotals(post, targetIds);
}
function reactions(metrics: ReturnType<typeof total>) {
  return metrics.likes + metrics.reposts;
}
function empty(text: string) {
  return `<p class="empty-state">${escapeHtml(text)}</p>`;
}
