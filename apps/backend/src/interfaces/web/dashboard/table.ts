import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey, VIDEO_PLATFORM_ICON_KEYS } from "./assets.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import { getTargetMetric, postMetricTotals } from "./metrics.js";
import { getTargetUrl } from "./target-url.js";
import type { PipelinePost } from "./types.js";
import type { VideoContentItem } from "./video-overview.js";

const NO_POSTS = "За выбранный период публикаций нет";
const DETAIL_BATCH_SIZE = 10;

export type PublicationDetailsResult = {
  html: string;
  total: number;
  loaded: number;
  remaining: number;
};

export type TrackPublicationListOptions = {
  limit?: number;
  /** Where "показать все N" goes. Omitted, the footer is not rendered at all. */
  moreUrl?: string | undefined;
};

/** Small ranked rows used by the split overview. */
export function renderTrackPublicationList(
  posts: PipelinePost[],
  targetIds: string[] = ORDERED_TARGETS.map((target) => target.id),
  videos: VideoContentItem[] = [],
  options: TrackPublicationListOptions = {},
): string {
  const limit = Math.max(1, options.limit ?? 4);
  const all = [
    ...posts.map((post) => {
      const metrics = total(post, targetIds);
      const target = primaryTarget(post, targetIds);
      return {
        date: post.date ?? "",
        views: metrics.views,
        reactions: reactions(metrics),
        replies: metrics.replies,
        title: shortPipelineText(post.text_ru || post.text_en || "Без текста", 14),
        tag: publicationTag(target?.id ?? "", target?.locale ?? null),
        icon: PLATFORM_ICONS[platformKey(target?.id ?? "")] ?? "",
        afterPeriodViews: 0,
        url: bestPostUrl(post, targetIds),
      };
    }),
    ...videos.map((video) => ({
      date: video.publishedAt ?? "",
      views: video.views,
      reactions: video.reactions,
      replies: video.replies,
      title: shortPipelineText(video.title, 14),
      tag: publicationTag(video.target, video.locale),
      icon: PLATFORM_ICONS[VIDEO_PLATFORM_ICON_KEYS[video.target] ?? ""] ?? "",
      afterPeriodViews: video.afterPeriodViews,
      url: video.url,
    })),
  ].sort((left, right) => right.views - left.views || right.date.localeCompare(left.date));
  const rows = all.slice(0, limit);

  if (!rows.length) return '<p class="empty-state">За выбранный период публикаций нет</p>';

  const more =
    options.moreUrl && all.length > rows.length
      ? `<a class="track-publication__more" href="${escapeHtml(options.moreUrl)}">показать все ${all.length}</a>`
      : "";

  return `${rows
    .map((row) => {
      const content = `<span class="track-publication__tag" title="${escapeHtml(row.tag)}">${row.icon}</span><span class="track-publication__title">${escapeHtml(row.title)}</span><span class="track-publication__stats"><b>${formatMetricValue(row.views)}</b>${row.afterPeriodViews > 0 ? `<small>+${formatMetricValue(row.afterPeriodViews)} после</small>` : ""}</span><span class="track-publication__meta">${formatMetricValue(row.reactions)} реакц. · ${formatMetricValue(row.replies)} отв.</span>`;
      return row.url
        ? `<a class="track-publication" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${content}</a>`
        : `<div class="track-publication">${content}</div>`;
    })
    .join("")}${more}`;
}

/** Thin, recent rows for the overview. */
export function renderOverviewPublicationList(
  posts: PipelinePost[],
  targetIds: string[] = ORDERED_TARGETS.map((target) => target.id),
  videos: VideoContentItem[] = [],
  options: TrackPublicationListOptions = {},
): string {
  const recent = [...publicationEntries(posts, targetIds, videos)].sort((left, right) => right.date.localeCompare(left.date));
  if (!recent.length) return empty(NO_POSTS);
  return `<div class="overview-publications__list">${renderRecentPublicationList(recent, Math.max(1, options.limit ?? 4), options.moreUrl)}</div>`;
}

function renderRecentPublicationList(entries: PublicationEntry[], limit: number, moreUrl?: string): string {
  const lazy = Boolean(moreUrl);
  const rows = lazy
    ? entries
        .slice(0, limit)
        .map((entry) => entry.recent(false))
        .join("")
    : entries.map((entry, index) => entry.recent(index >= limit)).join("");
  if (entries.length <= limit) return rows;
  const button = lazy
    ? `<button class="show-more-posts" type="button" data-more-url="${escapeHtml(moreUrl ?? "")}" data-more-offset="${limit}">Показать ещё <span>${entries.length - limit}</span></button>`
    : `<button class="show-more-posts" type="button">Показать ещё <span>${entries.length - limit}</span></button>`;
  return `${rows}${button}`;
}

/** Renders only a bounded fragment for the dashboard's read-only detail loader. */
export function renderPublicationDetails(
  posts: PipelinePost[],
  targetIds: string[] = ORDERED_TARGETS.map((target) => target.id),
  videos: VideoContentItem[] = [],
  offset = 0,
  limit = DETAIL_BATCH_SIZE,
): PublicationDetailsResult {
  const entries = publicationEntries(posts, targetIds, videos).sort((left, right) => right.date.localeCompare(left.date));
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.min(DETAIL_BATCH_SIZE, Math.floor(limit)));
  const selected = entries.slice(safeOffset, safeOffset + safeLimit);
  return {
    html: selected.map((entry) => entry.recent(false)).join(""),
    total: entries.length,
    loaded: selected.length,
    remaining: Math.max(0, entries.length - safeOffset - selected.length),
  };
}

type PublicationEntry = {
  date: string;
  recent: (hidden: boolean) => string;
};

function publicationEntries(posts: PipelinePost[], targetIds: string[], videos: VideoContentItem[]): PublicationEntry[] {
  return [
    ...posts.map((post) => ({
      date: post.date ?? "",
      recent: (hidden: boolean) => renderRecentPost(post, targetIds, hidden),
    })),
    ...videos.map((video) => ({
      date: video.publishedAt ?? "",
      recent: (hidden: boolean) => renderRecentVideo(video, hidden),
    })),
  ];
}

type PublicationPlatform = {
  name: string;
  locale: string;
  icon: string;
};

function textPublicationPlatforms(post: PipelinePost, targetIds: string[]): PublicationPlatform[] {
  return ORDERED_TARGETS.filter((target) => targetIds.includes(target.id) && targetStatus(post, target.id) === "published").map(
    (target) => ({
      name: target.label.replace(/\s(?:RU|EN)$/i, ""),
      locale: target.locale.toUpperCase(),
      icon: PLATFORM_ICONS[platformKey(target.id)] ?? "",
    }),
  );
}

function videoPublicationPlatforms(video: VideoContentItem): PublicationPlatform[] {
  const key = VIDEO_PLATFORM_ICON_KEYS[video.target] ?? video.target;
  const locale = video.locale?.toUpperCase() ?? "";
  const name = (video.label || video.target).replace(/\s(?:RU|EN)$/i, "");
  return [{ name, locale, icon: PLATFORM_ICONS[key] ?? "" }];
}

function publicationPlatformSummary(platforms: PublicationPlatform[]): string {
  if (!platforms.length) return "";
  if (platforms.length === 1) {
    const platform = platforms[0];
    if (!platform) return "";
    const label = platform.name + (platform.locale ? ` ${platform.locale}` : "");
    const locale = platform.locale ? `<b class="post-detail__platform-locale">${escapeHtml(platform.locale)}</b>` : "";
    return `<span class="post-detail__platform-summary" aria-label="${escapeHtml(label)}"><i class="platform-mark">${platform.icon}</i>${locale}</span>`;
  }

  const grouped = new Map<string, PublicationPlatform[]>();
  for (const platform of platforms) {
    const locale = platform.locale || "OTHER";
    const group = grouped.get(locale);
    if (group) group.push(platform);
    else grouped.set(locale, [platform]);
  }
  const localeOrder = ["EN", "RU", ...[...grouped.keys()].filter((locale) => locale !== "EN" && locale !== "RU")];
  const columns = localeOrder
    .filter((locale) => grouped.has(locale))
    .map((locale) => {
      const entries = grouped.get(locale) ?? [];
      return [
        `<div class="post-detail__platform-tooltip-column"><b>${escapeHtml(locale)}</b><ul>`,
        entries
          .map((platform) => `<li><i class="platform-mark">${platform.icon}</i><span>${escapeHtml(platform.name)}</span></li>`)
          .join(""),
        "</ul></div>",
      ].join("");
    })
    .join("");
  const labels = platforms.map((platform) => platform.name + (platform.locale ? ` ${platform.locale}` : ""));
  const accessible = escapeHtml(`${platforms.length} площадок: ${labels.join(", ")}`);
  return `<span class="post-detail__platform-summary post-detail__platform-summary--count" tabindex="0" aria-label="${accessible}"><b class="post-detail__platform-count">${platforms.length}</b><span class="post-detail__platform-tooltip" role="tooltip" aria-hidden="true">${columns}</span></span>`;
}

function renderRecentVideo(video: VideoContentItem, hidden: boolean): string {
  const extra = [
    video.afterPeriodViews > 0 ? `+${formatMetricValue(video.afterPeriodViews)} после периода` : "",
    video.subscribers ? `${video.subscribers > 0 ? "+" : ""}${formatMetricValue(video.subscribers)} подписки` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const rowTitle = [video.label || video.title, extra].filter(Boolean).join(" · ");
  const body = [
    '<span class="post-detail__summary">',
    '<span class="post-detail__headline"><span class="post-detail__chevron post-detail__chevron--link">↗</span>',
    `<span class="post-detail__title">${escapeHtml(shortPipelineText(video.title, 7))}</span></span>`,
    `<span class="post-detail__media">${publicationPlatformSummary(videoPublicationPlatforms(video))}</span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(video.views)}</span></span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(video.reactions)}</span></span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(video.replies)}</span></span>`,
    "</span>",
  ].join("");
  const className = `post-detail post-detail--flat${hidden ? " post-detail--more" : ""}`;
  return video.url
    ? `<a class="${className}" href="${escapeHtml(video.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(rowTitle)}">${body}</a>`
    : `<div class="${className}" title="${escapeHtml(rowTitle)}">${body}</div>`;
}

function bestPostUrl(post: PipelinePost, targetIds: string[]): string | null {
  const rankedTargets = [...targetIds].sort((left, right) => getTargetMetric(post, right, "views") - getTargetMetric(post, left, "views"));
  for (const target of rankedTargets) {
    const url = getTargetUrl(post, target);
    if (url) return url;
  }
  return null;
}

function primaryTarget(post: PipelinePost, targetIds: string[]) {
  return ORDERED_TARGETS.filter((target) => targetIds.includes(target.id) && targetStatus(post, target.id) === "published").sort(
    (left, right) => getTargetMetric(post, right.id, "views") - getTargetMetric(post, left.id, "views"),
  )[0];
}

function publicationTag(target: string, locale: string | null): string {
  const short = target.startsWith("youtube")
    ? "YT"
    : target.startsWith("instagram")
      ? "IG"
      : target.startsWith("telegram")
        ? "TG"
        : target.startsWith("threads")
          ? "TH"
          : target.startsWith("site")
            ? "SITE"
            : target === "x"
              ? "X"
              : target.toUpperCase();
  return `${short}${locale ? ` ${locale.toUpperCase()}` : ""}`;
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
    `<span class="post-detail__title">${escapeHtml(shortPipelineText(english, 7))}</span>`,
    "</span>",
    `<span class="post-detail__media">${publicationPlatformSummary(textPublicationPlatforms(post, targetIds))}</span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(metrics.views)}</span></span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(reactions(metrics))}</span></span>`,
    `<span class="post-detail__metric"><span>${formatMetricValue(metrics.replies)}</span></span>`,
    "</span></summary>",
    '<div class="post-detail__body">',
    platformBreakdown(post, targetIds),
    '<div class="post-detail__content"><div>',
    `<span class="post-detail__label">ENGLISH</span><p>${escapeHtml(english)}</p>`,
    `<span class="post-detail__label">RU ORIGINAL</span><p>${escapeHtml(russian)}</p>`,
    "</div>",
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
    published.map((target) => platformMetrics(post, target.id, target.locale)).join(""),
    "</div>",
    "</section>",
  ].join("");
}

function platformMetrics(post: PipelinePost, targetId: string, locale: string): string {
  const url = getTargetUrl(post, targetId);
  const metrics = {
    views: getTargetMetric(post, targetId, "views"),
    reactions: getTargetMetric(post, targetId, "likes") + getTargetMetric(post, targetId, "reposts"),
    replies: getTargetMetric(post, targetId, "replies"),
  };
  const name = `<span class="post-platform__name">${PLATFORM_ICONS[platformKey(targetId)] ?? ""}<b class="post-platform__locale">${escapeHtml(locale.toUpperCase())}</b></span>`;
  const metric = (label: string, value: number) => {
    const formatted = formatMetricValue(value);
    return `<span class="post-platform__metric" title="${label}" aria-label="${label}: ${formatted}"><b>${formatted}</b></span>`;
  };
  const content = `${name}<span class="post-platform__metrics">${metric("Охват", metrics.views)}${metric("Реакции", metrics.reactions)}${metric("Ответы", metrics.replies)}</span>`;
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

function total(post: PipelinePost, targetIds: string[]) {
  return postMetricTotals(post, targetIds);
}
function reactions(metrics: ReturnType<typeof total>) {
  return metrics.likes + metrics.reposts;
}
function empty(text: string) {
  return `<p class="empty-state">${escapeHtml(text)}</p>`;
}
