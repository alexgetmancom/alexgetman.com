import { ORDERED_TARGETS } from "./assets.js";
import { formatMetricValue, formatTimeMsk, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import { formatMedia, postMetricTotals } from "./metrics.js";
import type { PipelinePost } from "./types.js";

const targetIds = ORDERED_TARGETS.map((target) => target.id);

export function renderPublicationColumns(posts: PipelinePost[]): string {
  const ranked = [...posts]
    .sort((left, right) => total(left).views - total(right).views)
    .reverse()
    .slice(0, 3);
  return `<div class="publication-columns"><section class="best-posts"><div class="section-kicker">Лучшие публикации</div>${ranked.length ? ranked.map((post, index) => renderBestPost(post, index + 1)).join("") : empty("За выбранный период публикаций нет")}</section><section class="recent-posts"><div class="section-kicker">Последние публикации</div>${
    posts.length
      ? posts
          .slice(0, 5)
          .map((post, index) => renderRecentPost(post, index === 0))
          .join("")
      : empty("За выбранный период публикаций нет")
  }</section></div>`;
}

function renderBestPost(post: PipelinePost, rank: number): string {
  const metrics = total(post);
  return `<article class="best-post"><span class="post-rank">${rank}</span><div><div class="best-post__title">${escapeHtml(shortPipelineText(post.text_ru || post.text_en || "Без текста", 12))}</div><div class="post-meta">${formatMetricValue(metrics.views)} просмотров · ${formatMetricValue(interactions(metrics))} реакций</div></div></article>`;
}

function renderRecentPost(post: PipelinePost, open: boolean): string {
  const metrics = total(post);
  const time = formatTimeMsk(post.date);
  const english = post.full_text_en || post.text_en || "Без английского текста";
  const russian = post.full_text_ru || post.text_ru || "—";
  return `<details class="post-detail"${open ? " open" : ""}><summary><span class="post-detail__summary"><span class="post-detail__time">${escapeHtml(time)}</span><span class="post-detail__title">${escapeHtml(shortPipelineText(english, 12))}</span><span class="post-detail__stats">${formatMetricValue(metrics.views)} · ${formatMetricValue(interactions(metrics))}</span></span></summary><div class="post-detail__body"><div><span class="post-detail__label">ENGLISH</span><p>${escapeHtml(english)}</p><span class="post-detail__label">RU ORIGINAL</span><p>${escapeHtml(russian)}</p></div>${mediaPreview(post)}</div></details>`;
}

function mediaPreview(post: PipelinePost): string {
  const media = post.media_en_json ?? post.media_json ?? post.media_ru_json;
  const url = mediaUrl(media);
  if (url)
    return `<a class="post-preview" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(url)}" alt="Превью медиа"></a>`;
  return `<div class="post-preview post-preview--empty">${escapeHtml(formatMedia(post) || "media")}</div>`;
}

function mediaUrl(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || typeof first !== "object") return null;
  const candidate =
    (first as Record<string, unknown>).url ?? (first as Record<string, unknown>).public_url ?? (first as Record<string, unknown>).vps_url;
  return typeof candidate === "string" && (/^https:\/\//.test(candidate) || candidate.startsWith("/")) ? candidate : null;
}

function total(post: PipelinePost) {
  return postMetricTotals(post, targetIds);
}
function interactions(metrics: ReturnType<typeof total>) {
  return metrics.likes + metrics.replies + metrics.reposts;
}
function empty(text: string) {
  return `<p class="empty-state">${escapeHtml(text)}</p>`;
}
