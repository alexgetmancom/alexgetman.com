import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey, VIDEO_PLATFORM_ICON_KEYS } from "./assets.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import { formatMedia, getTargetMetric, postMetricTotals } from "./metrics.js";
import { getTargetUrl } from "./target-url.js";
import type { PipelinePost } from "./types.js";
import type { VideoContentItem } from "./video-overview.js";

const NO_POSTS = "За выбранный период публикаций нет";
const VISIBLE_RECENT = 5;

/**
 * The two content columns, over both halves of the feed.
 *
 * Text and video are ranked and listed in one sequence rather than in two
 * lists: they compete for the same attention, and a split makes "what worked
 * this week" a question the operator has to answer by eye. Video rows are not
 * expandable — there is no second locale and no post body to reveal — so they
 * render as a plain row in the same grid.
 */
export function renderPublicationColumns(
  posts: PipelinePost[],
  targetIds: string[] = ORDERED_TARGETS.map((target) => target.id),
  videos: VideoContentItem[] = [],
): string {
  const entries = [
    ...posts.map((post) => ({
      date: post.date ?? "",
      views: total(post, targetIds).views,
      reactions: reactions(total(post, targetIds)),
      best: (rank: number) => renderBestPost(post, targetIds, rank),
      recent: (hidden: boolean) => renderRecentPost(post, targetIds, hidden),
    })),
    ...videos.map((video) => ({
      date: video.publishedAt ?? "",
      views: video.views,
      reactions: video.reactions,
      best: (rank: number) => renderBestVideo(video, rank),
      recent: (hidden: boolean) => renderRecentVideo(video, hidden),
    })),
  ];
  const ranked = [...entries].sort((left, right) => right.views - left.views).slice(0, 3);
  const recent = [...entries].sort((left, right) => right.date.localeCompare(left.date));
  return [
    '<div class="publication-columns">',
    '<section class="best-posts">',
    '<div class="section-kicker">Лучшие публикации</div>',
    ranked.length ? ranked.map((entry, index) => entry.best(index + 1)).join("") : empty(NO_POSTS),
    "</section>",
    '<section class="recent-posts">',
    '<header class="recent-posts__header">',
    '<div class="section-kicker">Последние публикации</div>',
    "<span>Площадки</span><span>Охват</span><span>Реакции</span><span>Ответы</span>",
    "</header>",
    recent.length ? recent.map((entry, index) => entry.recent(index >= VISIBLE_RECENT)).join("") : empty(NO_POSTS),
    recent.length > VISIBLE_RECENT
      ? `<button class="show-more-posts" type="button">Показать ещё <span>${recent.length - VISIBLE_RECENT}</span></button>`
      : "",
    "</section>",
    "</div>",
  ].join("");
}

function renderBestPost(post: PipelinePost, targetIds: string[], rank: number): string {
  const metrics = total(post, targetIds);
  const title = escapeHtml(shortPipelineText(post.text_ru || post.text_en || "Без текста", 10));
  const url = bestPostUrl(post, targetIds);
  return bestBody(rank, title, platformIcons(post, targetIds), metrics.views, reactions(metrics), url);
}

function renderBestVideo(video: VideoContentItem, rank: number): string {
  return bestBody(rank, escapeHtml(shortPipelineText(video.title, 10)), videoIcon(video.target), video.views, video.reactions, video.url);
}

function bestBody(rank: number, title: string, icons: string, views: number, likes: number, url: string | null): string {
  const opening = url
    ? `<a class="best-post" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">`
    : '<article class="best-post">';
  return [
    opening,
    `<span class="post-rank">${rank}</span>`,
    `<div class="best-post__copy"><div class="best-post__title">${title}</div><div class="best-post__icons">${icons}</div></div>`,
    '<div class="best-post__stats">',
    `<strong>${formatMetricValue(views)}</strong><small>просмотры</small>`,
    `<em>♡ ${formatMetricValue(likes)}</em>`,
    "</div>",
    url ? "</a>" : "</article>",
  ].join("");
}

/** The platform column is icons, not words: the same four or five marks repeat
 * on every row, and spelled out they were the widest thing in the list. */
function platformIcons(post: PipelinePost, targetIds: string[]): string {
  const keys = new Set(
    ORDERED_TARGETS.filter((target) => targetIds.includes(target.id) && targetStatus(post, target.id) === "published").map((target) =>
      platformKey(target.id),
    ),
  );
  return [...keys].map((key) => `<i class="platform-mark">${PLATFORM_ICONS[key] ?? ""}</i>`).join("");
}

function videoIcon(target: string): string {
  return `<i class="platform-mark">${PLATFORM_ICONS[VIDEO_PLATFORM_ICON_KEYS[target] ?? ""] ?? ""}</i>`;
}

function renderRecentVideo(video: VideoContentItem, hidden: boolean): string {
  const body = [
    '<span class="post-detail__summary">',
    '<span class="post-detail__headline"><span class="post-detail__chevron post-detail__chevron--link">↗</span>',
    `<span class="post-detail__title">${escapeHtml(shortPipelineText(video.title, 11))}</span></span>`,
    `<span class="post-detail__media">${videoIcon(video.target)}</span>`,
    `<span>${formatMetricValue(video.views)}</span>`,
    `<span>${formatMetricValue(video.reactions)}</span>`,
    `<span>${formatMetricValue(video.replies)}</span>`,
    "</span>",
  ].join("");
  const className = `post-detail post-detail--flat${hidden ? " post-detail--more" : ""}`;
  return video.url
    ? `<a class="${className}" href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer">${body}</a>`
    : `<div class="${className}">${body}</div>`;
}

function bestPostUrl(post: PipelinePost, targetIds: string[]): string | null {
  const rankedTargets = [...targetIds].sort((left, right) => getTargetMetric(post, right, "views") - getTargetMetric(post, left, "views"));
  for (const target of rankedTargets) {
    const url = getTargetUrl(post, target);
    if (url) return url;
  }
  return null;
}

function renderRecentPost(post: PipelinePost, targetIds: string[], hidden: boolean): string {
  const metrics = total(post, targetIds);
  const english = post.full_text_en || post.text_en || "Без английского текста";
  const russian = post.full_text_ru || post.text_ru || "—";
  return [
    `<details class="post-detail${hidden ? " post-detail--more" : ""}">`,
    '<summary><span class="post-detail__summary">',
    '<span class="post-detail__headline">',
    '<span class="post-detail__chevron">›</span>',
    `<span class="post-detail__title">${escapeHtml(shortPipelineText(english, 11))}</span>`,
    "</span>",
    `<span class="post-detail__media">${platformIcons(post, targetIds)}</span>`,
    `<span>${formatMetricValue(metrics.views)}</span>`,
    `<span>${formatMetricValue(reactions(metrics))}</span>`,
    `<span>${formatMetricValue(metrics.replies)}</span>`,
    "</span></summary>",
    '<div class="post-detail__body">',
    platformBreakdown(post, targetIds),
    '<div class="post-detail__content"><div>',
    `<span class="post-detail__label">ENGLISH</span><p>${escapeHtml(english)}</p>`,
    `<span class="post-detail__label">RU ORIGINAL</span><p>${escapeHtml(russian)}</p>`,
    "</div>",
    mediaPreview(post),
    "</div></div>",
    "</details>",
  ].join("");
}

function platformBreakdown(post: PipelinePost, targetIds: string[]): string {
  const published = ORDERED_TARGETS.filter((target) => targetIds.includes(target.id) && targetStatus(post, target.id) === "published");
  if (!published.length) return "";
  return [
    '<section class="post-platforms" aria-label="Метрики по площадкам">',
    '<span class="post-detail__label">РЕЗУЛЬТАТ ПО ПЛОЩАДКАМ</span>',
    '<div class="post-platforms__grid">',
    published.map((target) => platformMetrics(post, target.id, target.label)).join(""),
    "</div>",
    "</section>",
  ].join("");
}

function platformMetrics(post: PipelinePost, targetId: string, label: string): string {
  const url = getTargetUrl(post, targetId);
  const metrics = {
    views: getTargetMetric(post, targetId, "views"),
    reactions: getTargetMetric(post, targetId, "likes") + getTargetMetric(post, targetId, "reposts"),
    replies: getTargetMetric(post, targetId, "replies"),
  };
  const name = `<span class="post-platform__name">${PLATFORM_ICONS[platformKey(targetId)] ?? ""}<span>${escapeHtml(label)}</span></span>`;
  const content = `${name}<span class="post-platform__metrics"><b>${formatMetricValue(metrics.views)}</b> охват <b>${formatMetricValue(metrics.reactions)}</b> реакции <b>${formatMetricValue(metrics.replies)}</b> ответы</span>`;
  return url
    ? `<a class="post-platform" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${content}</a>`
    : `<div class="post-platform">${content}</div>`;
}

function targetStatus(post: PipelinePost, target: string): string | null {
  const status = post.targets?.[target]?.status;
  if (status && status !== "unknown") return status;
  if (target === "telegram" && post.telegram_url) return "published";
  if (target === "site_ru" && post.site_ru) return "published";
  if (target === "site_en" && post.site_en) return "published";
  return null;
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

function total(post: PipelinePost, targetIds: string[]) {
  return postMetricTotals(post, targetIds);
}
function reactions(metrics: ReturnType<typeof total>) {
  return metrics.likes + metrics.reposts;
}
function empty(text: string) {
  return `<p class="empty-state">${escapeHtml(text)}</p>`;
}
