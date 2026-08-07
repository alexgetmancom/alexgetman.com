import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { targetLocale } from "../../../botTargets.js";
import { escapeHtml } from "../../../foundation/html.js";
import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey, VIDEO_PLATFORM_ICON_KEYS } from "./assets.js";
import { renderOverviewSparkline } from "./chart.js";
import {
  calendarKey,
  emptyTotals,
  formatPlatformDelta,
  medianDetails,
  medianOfDays,
  metricProgress,
  percentDelta,
  periodContextLabel,
  periodCountLabel,
  periodNormLabel,
  periodPaceLabel,
  periodProjection,
  scaleTextDetails,
  scaleTotals,
  type TextDetails,
  type Totals,
} from "./combined-math.js";
import { formatMetricValue } from "./format.js";
import { renderHeroCard, renderHeroMicroMetrics, type TextHeroMetrics, type VideoHeroMetrics } from "./hero-section.js";
import { getTargetMetric, postMetricTotals } from "./metrics.js";
import { renderOverviewPublicationList } from "./table.js";
import type { PipelineData, PipelinePost } from "./types.js";
import type { VideoOverview } from "./video-overview.js";

/**
 * The unified overview: text and video on one screen, under one period.
 *
 * The two feeds are equal here, which rules out the obvious shortcut of adding
 * them together. A Shorts view and a Threads view are not the same unit — one
 * is an autoplay in a scrolling feed, the other a deliberate read — so a single
 * "104.9k views" figure would be dominated by video and its delta would report
 * video's day as the whole day's. Every KPI therefore carries the two numbers
 * side by side, each with its own comparison, and the sum is never shown.
 */

export type PlatformMetric = "reach" | "followers";

export type TextPlatformFollowers = { key: string; label: string; followers: number | null };

export type CombinedSectionInput = {
  data: PipelineData | null;
  previousData: PipelineData | null;
  xItems: XActivityDashboardItem[];
  previousXItems: XActivityDashboardItem[];
  dayComparisonData?: PipelineData | null;
  video: VideoOverview;
  previousVideo: VideoOverview;
  dayComparisonVideo?: VideoOverview | null;
  /** Thirty-day history immediately before the selected period, used by the
   * hero cards as a comparable median baseline. */
  medianData?: PipelineData | null;
  medianXItems?: XActivityDashboardItem[];
  medianVideo?: VideoOverview | null;
  followers: TextPlatformFollowers[];
  rangeStart: Date;
  rangeEnd: Date;
  periodDays: number;
  weekOffset: number;
  timeZone: string;
  platformMetric: PlatformMetric;
  /** Restricts the text half when a platform row is selected. */
  textTargetIds?: readonly string[] | undefined;
  /** The selected text platform, if this is a scoped overview. */
  textView?: string | undefined;
  publicationDetailsUrl?: string;
};

const TEXT_COLOR = "var(--series-text)";
const VIDEO_COLOR = "var(--series-video)";

export function renderCombinedSection(input: CombinedSectionInput): string {
  const { periodDays, timeZone } = input;
  const textTargetIds = selectedTextTargetIds(input);
  const posts = input.data?.posts ?? [];
  const previousPosts = input.previousData?.posts ?? [];
  const extraX = additionalXItems(posts, input.xItems);
  const previousExtraX = additionalXItems(previousPosts, input.previousXItems);

  const showText = true;
  const showVideo = !input.textView;

  const text = combinedTotals(posts, extraX, textTargetIds);
  const previousText =
    periodDays === 1
      ? medianDailyTextDetails(previousPosts, previousExtraX, 30, timeZone, textTargetIds)
      : combinedTotals(previousPosts, previousExtraX, textTargetIds);
  const previousVideoTotals =
    periodDays === 1
      ? medianDailyVideoTotals(input.previousVideo, 30)
      : {
          views: input.previousVideo.totals.views,
          reactions: input.previousVideo.totals.reactions,
          replies: input.previousVideo.totals.replies,
        };
  const textHero = textHeroMetrics(
    input,
    posts,
    extraX,
    previousPosts,
    previousExtraX,
    periodDays,
    timeZone,
    text,
    previousText,
    textTargetIds,
  );
  const videoHero = videoHeroMetrics(input, periodDays, previousVideoTotals);
  const comparisonPosts = periodDays === 1 ? (input.dayComparisonData?.posts ?? previousPosts) : previousPosts;
  const comparisonX = periodDays === 1 ? input.previousXItems : previousExtraX;
  const textColumn = showText
    ? renderOverviewColumn("text", input, textHero, posts, extraX, comparisonPosts, comparisonX, showText && !showVideo)
    : "";
  const videoColumn = showVideo ? renderOverviewColumn("video", input, videoHero, [], [], [], [], showVideo && !showText) : "";

  return `<section class="pipeline-overview">
    <div class="overview-split${showText && showVideo ? "" : " overview-split--single"}">
      ${textColumn}
      ${videoColumn}
    </div>
    <div class="chart-tooltip overview-chart-tooltip" hidden></div>
  </section>`;
}

type OverviewKind = "text" | "video";
type OverviewPlatformRow = {
  key: string;
  label: string;
  locale: string | null;
  icon: string;
  views: number;
  followers: number | null;
  delta: number | null;
  href: string | null;
  secondary?: boolean;
};

function renderOverviewColumn(
  kind: "text",
  input: CombinedSectionInput,
  hero: TextHeroMetrics,
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  comparisonPosts: PipelinePost[],
  comparisonX: XActivityDashboardItem[],
  single: boolean,
): string;
function renderOverviewColumn(
  kind: "video",
  input: CombinedSectionInput,
  hero: VideoHeroMetrics,
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  comparisonPosts: PipelinePost[],
  comparisonX: XActivityDashboardItem[],
  single: boolean,
): string;
function renderOverviewColumn(
  kind: OverviewKind,
  input: CombinedSectionInput,
  hero: TextHeroMetrics | VideoHeroMetrics,
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  comparisonPosts: PipelinePost[],
  comparisonX: XActivityDashboardItem[],
  single: boolean,
): string {
  const color = kind === "text" ? TEXT_COLOR : VIDEO_COLOR;
  const currentPosts = kind === "text" ? posts : [];
  const currentX = kind === "text" ? extraX : [];
  const textTargetIds = selectedTextTargetIds(input);
  const history = overviewHistory(input, kind, currentPosts, currentX);
  const platformRows = overviewPlatformRows(
    input,
    kind,
    currentPosts,
    kind === "text" ? input.xItems : currentX,
    comparisonPosts,
    comparisonX,
  );
  const showMetricFilter = single || kind === "text";
  const publicationMarkup =
    kind === "text"
      ? renderOverviewPublicationList(input.textView === "x" ? [...posts, ...currentX.map(xChartPost)] : posts, textTargetIds, [], {
          limit: 4,
          moreUrl: input.publicationDetailsUrl,
        })
      : renderOverviewPublicationList([], [], input.video.items, { limit: 4, moreUrl: input.publicationDetailsUrl });
  const heroMarkup = kind === "text" ? renderHeroCard("text", hero as TextHeroMetrics) : renderHeroCard("video", hero as VideoHeroMetrics);
  const microMarkup =
    kind === "text" ? renderHeroMicroMetrics("text", hero as TextHeroMetrics) : renderHeroMicroMetrics("video", hero as VideoHeroMetrics);
  const title = kind === "text" ? "Текст" : "Видео";
  const historyLabel = input.periodDays === 1 ? "30 дней назад" : "начало периода";
  const historyRightLabel = input.periodDays === 1 ? "сегодня" : "конец периода";
  return `<section class="overview-track overview-track--${kind}${single ? " overview-track--single" : ""}">
    ${heroMarkup}
    ${renderOverviewSparkline(history, color, `Динамика просмотров: ${title}`, historyLabel, historyRightLabel)}
    ${microMarkup}
    ${renderOverviewPlatforms(input, kind, platformRows, showMetricFilter)}
    <div class="overview-publications" id="overview-publications-${kind}">
      <div class="overview-kicker">ПУБЛИКАЦИИ</div>
      ${publicationMarkup}
    </div>
  </section>`;
}

function renderOverviewPlatforms(
  input: CombinedSectionInput,
  kind: OverviewKind,
  rows: OverviewPlatformRow[],
  showMetricFilter: boolean,
): string {
  const color = kind === "text" ? TEXT_COLOR : VIDEO_COLOR;
  const metricValue = (row: OverviewPlatformRow): number | null => (input.platformMetric === "reach" ? row.views : row.followers);
  const total = rows.reduce((sum, row) => sum + (metricValue(row) ?? 0), 0);
  const localeTotal = (locale: string) =>
    rows.reduce((sum, row) => sum + (row.locale?.toLowerCase() === locale ? (metricValue(row) ?? 0) : 0), 0);
  const ru = localeTotal("ru");
  const en = localeTotal("en");
  const segments =
    total > 0
      ? rows
          .map((row, index) => {
            const value = metricValue(row) ?? 0;
            if (value <= 0) return "";
            const opacity = Math.max(0.2, 1 - index * 0.2);
            const share = (value / total) * 100;
            const tooltip = `${row.label}${row.locale ? ` ${row.locale.toUpperCase()}` : ""} · ${formatMetricValue(value)} · ${share.toFixed(1)}%${row.delta === null ? "" : ` · ${formatPlatformDelta(row.delta)}`}`;
            return `<i data-tooltip="${escapeHtml(tooltip)}" style="width:${share.toFixed(3)}%;background:${color};opacity:${opacity.toFixed(2)}"></i>`;
          })
          .join("")
      : `<i class="overview-platforms__empty-segment" style="width:100%;background:${color}"></i>`;
  // Keep the four largest destinations in the visible legend. The full bar
  // still carries every source in its hover text, while the small drawer keeps
  // the publication list immediately below the first four rows.
  const ranked = input.platformMetric === "reach" ? rows : rows.filter((row) => !row.secondary);
  const visibleRows = ranked.slice(0, PLATFORM_SLOTS);
  const hiddenRows = ranked.slice(PLATFORM_SLOTS);
  const renderRow = (row: OverviewPlatformRow): string => {
    const value = metricValue(row);
    const formatted = value === null ? "—" : formatMetricValue(value);
    const delta = input.platformMetric === "reach" ? formatPlatformDelta(row.delta) : "";
    const body = `<span class="overview-platform__icon" style="color:${color}">${row.icon}</span><span class="overview-platform__name">${row.locale ? `<b>${escapeHtml(row.locale.toUpperCase())}</b>` : ""}</span><strong>${formatted}</strong><span class="overview-platform__delta ${row.delta !== null && row.delta >= 0 ? "overview-platform__delta--up" : "overview-platform__delta--down"}">${delta || "\u00a0"}</span>`;
    return row.href
      ? `<a class="overview-platform" href="${escapeHtml(row.href)}" title="${escapeHtml(row.label)}" aria-label="${escapeHtml(row.label)}">${body}</a>`
      : `<div class="overview-platform" title="${escapeHtml(row.label)}" aria-label="${escapeHtml(row.label)}">${body}</div>`;
  };
  const platformRows = visibleRows.map(renderRow).join("");
  const more = hiddenRows.length
    ? `<details class="overview-platforms__more platform-more"><summary>Ещё <span>${hiddenRows.length}</span></summary><div class="platform-more__list">${hiddenRows.map(renderRow).join("")}</div></details>`
    : `<a class="overview-platforms__more overview-platforms__more--jump" href="#overview-publications-${kind}">Публикации</a>`;
  const filter = showMetricFilter
    ? renderPlatformMetricFilter(input.platformMetric, input.periodDays, input.weekOffset, input.textView)
    : "";
  // No kicker over the bar: the RU/EN labels already name the row, and a second
  // heading only pushed the first number further down. The metric switch stays —
  // it is a real filter, not decoration — but as a bare pair of links on the
  // same line as the labels rather than a bordered control of its own.
  return `<div class="overview-platforms">
    <div class="overview-platforms__bar-labels"><span>RU</span>${filter}<span>EN</span></div>
    <div class="overview-platforms__bar">${segments}</div>
    <div class="overview-platforms__legend"><span><b>${formatMetricValue(ru)}</b> · ${total > 0 ? Math.round((ru / total) * 100) : 0}%</span><span>${total > 0 ? Math.round((en / total) * 100) : 0}% · <b>${formatMetricValue(en)}</b></span></div>
    <div class="overview-platforms__rows">${platformRows}</div>
    ${more}
  </div>`;
}

function overviewPlatformRows(
  input: CombinedSectionInput,
  kind: OverviewKind,
  currentPosts: PipelinePost[],
  currentX: XActivityDashboardItem[],
  comparisonPosts: PipelinePost[],
  comparisonX: XActivityDashboardItem[],
): OverviewPlatformRow[] {
  if (kind === "video") {
    return input.video.platforms
      .map((platform) => {
        const previous = input.periodDays === 1 ? (input.dayComparisonVideo?.platforms ?? []) : input.previousVideo.platforms;
        const previousRow = previous.find(
          (item) => item.target === platform.target && item.locales.join(",") === platform.locales.join(","),
        );
        return {
          key: `${platform.target}:${platform.locales.join(",")}`,
          label: platform.label,
          locale: platform.locales[0] ?? null,
          icon: PLATFORM_ICONS[VIDEO_PLATFORM_ICON_KEYS[platform.target] ?? ""] ?? "",
          views: platform.views,
          followers: platform.followers,
          delta: previousRow ? percentDelta(platform.views, previousRow.views) : null,
          href: null,
          secondary: false,
        };
      })
      .sort((left, right) =>
        input.platformMetric === "reach" ? right.views - left.views : (right.followers ?? -1) - (left.followers ?? -1),
      );
  }

  const textTargetIds = selectedTextTargetIds(input);
  const rows = input.followers
    .filter((platform) => textTargetIds.includes(platform.key))
    .map((platform) => ({
      key: platform.key,
      label: platform.label,
      locale: targetLocale(platform.key),
      icon: PLATFORM_ICONS[platform.key.startsWith("threads") ? "threads" : platformKey(platform.key)] ?? "",
      views: platformViews(platform.key, currentPosts, currentX),
      followers: platform.followers,
      delta: percentDelta(platformViews(platform.key, currentPosts, currentX), platformViews(platform.key, comparisonPosts, comparisonX)),
      href: input.textView
        ? null
        : `/command-center?period=${input.periodDays}&week_offset=${input.weekOffset}&view=${encodeURIComponent(platform.key)}`,
      secondary: SECONDARY_TEXT_TARGETS.has(platform.key),
    }));
  const known = new Set(rows.map((row) => row.key));
  const publishedTargets = ORDERED_TARGETS.filter(
    (target) => textTargetIds.includes(target.id) && !known.has(target.id) && hasTextTargetData(currentPosts, target.id),
  ).map((target) => ({
    key: target.id,
    label: target.label,
    locale: target.locale,
    icon: PLATFORM_ICONS[platformKey(target.id)] ?? "",
    views: platformViews(target.id, currentPosts, currentX),
    followers: null,
    delta: percentDelta(platformViews(target.id, currentPosts, currentX), platformViews(target.id, comparisonPosts, comparisonX)),
    href: null,
    secondary: SECONDARY_TEXT_TARGETS.has(target.id),
  }));
  return [...rows, ...publishedTargets].sort((left, right) =>
    input.platformMetric === "reach" ? right.views - left.views : (right.followers ?? -1) - (left.followers ?? -1),
  );
}

function selectedTextTargetIds(input: CombinedSectionInput): string[] {
  return input.textTargetIds ? [...input.textTargetIds] : ORDERED_TARGETS.map((target) => target.id);
}

function overviewHistory(
  input: CombinedSectionInput,
  kind: OverviewKind,
  currentPosts: PipelinePost[],
  currentX: XActivityDashboardItem[],
): Array<{ label: string; value: number }> {
  const textTargetIds = selectedTextTargetIds(input);
  const current =
    kind === "text"
      ? textViewsByDay([...currentPosts, ...currentX.map(xChartPost)], input.timeZone, textTargetIds)
      : videoViewsByDay(input.video);
  if (input.periodDays === 1) {
    const previous =
      kind === "text"
        ? textViewsByDay(
            [
              ...(input.previousData?.posts ?? []),
              ...additionalXItems(input.previousData?.posts ?? [], input.previousXItems).map(xChartPost),
            ],
            input.timeZone,
            textTargetIds,
          )
        : videoViewsByDay(input.previousVideo);
    const points: Array<{ label: string; value: number }> = [];
    for (let index = -29; index <= 0; index += 1) {
      const day = new Date(input.rangeEnd);
      day.setUTCDate(day.getUTCDate() + index);
      const key = day.toISOString().slice(0, 10);
      points.push({ label: key, value: current[key] ?? previous[key] ?? 0 });
    }
    return points;
  }

  const points: Array<{ label: string; value: number }> = [];
  for (let index = 0; index < input.periodDays; index += 1) {
    const day = new Date(input.rangeStart);
    day.setUTCDate(day.getUTCDate() + index);
    const key = day.toISOString().slice(0, 10);
    points.push({ label: key, value: current[key] ?? 0 });
  }
  return points;
}

function textHeroMetrics(
  input: CombinedSectionInput,
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  previousPosts: PipelinePost[],
  previousExtraX: XActivityDashboardItem[],
  periodDays: number,
  timeZone: string,
  current: Totals,
  fallbackMedian: Totals,
  textTargetIds: readonly string[],
): TextHeroMetrics {
  const currentDetails = textDetails(posts, extraX, textTargetIds);
  const hasMedianData = Boolean(input.medianData && ((input.medianData.posts?.length ?? 0) > 0 || input.medianXItems?.length));
  const medianSource = hasMedianData ? (input.medianData?.posts ?? []) : previousPosts;
  const medianExtraX = hasMedianData ? (input.medianXItems ?? []) : previousExtraX;
  const medianDetails =
    hasMedianData && periodDays > 1
      ? scaleTextDetails(medianDailyTextDetails(medianSource, medianExtraX, 30, timeZone, textTargetIds), periodDays)
      : periodDays === 1
        ? medianDailyTextDetails(medianSource, medianExtraX, 30, timeZone, textTargetIds)
        : textDetails(previousPosts, previousExtraX, textTargetIds);
  const median = hasMedianData || periodDays === 1 ? medianDetails : fallbackMedian;
  const views = current.views;
  const progressPercent = metricProgress(views, median.views);
  return {
    postCount: posts.length,
    views,
    medianViews: median.views,
    reactions: currentDetails.reactions,
    replies: currentDetails.replies,
    reposts: currentDetails.reposts,
    engagementRate: views > 0 ? (currentDetails.reactions / views) * 100 : null,
    countLabel: periodCountLabel(posts.length, "пост", periodDays),
    normLabel: periodNormLabel(periodDays),
    contextLabel: periodContextLabel(input.rangeEnd, periodDays, timeZone),
    paceLabel: periodPaceLabel(views, median.views, input.rangeEnd, periodDays, timeZone),
    projectionViews: periodProjection(views, input.rangeEnd, periodDays, timeZone),
    progressPercent,
  };
}

function videoHeroMetrics(input: CombinedSectionInput, periodDays: number, fallbackMedian: Totals): VideoHeroMetrics {
  const median = hasVideoHistory(input.medianVideo)
    ? medianVideoViews(input.medianVideo, periodDays)
    : hasVideoHistory(input.previousVideo) && periodDays === 1
      ? medianDailyVideoTotals(input.previousVideo, 30)
      : hasVideoHistory(input.previousVideo)
        ? fallbackMedian
        : null;
  const progressPercent = metricProgress(input.video.totals.views, median?.views ?? null);
  return {
    videoCount: input.video.totals.posts,
    views: input.video.totals.views,
    medianViews: median?.views ?? null,
    completionRate: input.video.summary.completionRate,
    averageWatchTimeMs: input.video.summary.averageWatchTimeMs,
    subscribers: input.video.summary.subscribers,
    countLabel: periodCountLabel(input.video.totals.posts, "ролик", periodDays),
    normLabel: periodNormLabel(periodDays),
    contextLabel: periodContextLabel(input.rangeEnd, periodDays, input.timeZone),
    paceLabel: periodPaceLabel(input.video.totals.views, median?.views ?? null, input.rangeEnd, periodDays, input.timeZone),
    projectionViews: periodProjection(input.video.totals.views, input.rangeEnd, periodDays, input.timeZone),
    progressPercent,
  };
}

function hasVideoHistory(video: VideoOverview | null | undefined): video is VideoOverview {
  return Boolean(video && (video.items.length > 0 || Object.keys(video.dailyByDay).length > 0));
}

function textDetails(
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  targetIds: readonly string[] = ORDERED_TARGETS.map((target) => target.id),
): TextDetails {
  const details = posts.reduce(
    (totals, post) => {
      const metrics = postMetricTotals(post, [...targetIds]);
      totals.views += metrics.views;
      totals.reactions += metrics.likes + metrics.reposts;
      totals.replies += metrics.replies;
      totals.reposts += metrics.reposts;
      return totals;
    },
    { views: 0, reactions: 0, replies: 0, reposts: 0 },
  );
  for (const item of extraX) {
    details.views += metric(item, "views");
    details.reactions += metric(item, "interactions");
    details.replies += metric(item, "replies");
    details.reposts += metric(item, "reposts");
  }
  return details;
}

function medianDailyTextDetails(
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  days: number,
  timeZone: string,
  targetIds: readonly string[] = ORDERED_TARGETS.map((target) => target.id),
): TextDetails {
  const daily = new Map<string, TextDetails>();
  const add = (key: string | null, values: TextDetails) => {
    if (!key) return;
    const bucket = daily.get(key) ?? { views: 0, reactions: 0, replies: 0, reposts: 0 };
    bucket.views += values.views;
    bucket.reactions += values.reactions;
    bucket.replies += values.replies;
    bucket.reposts += values.reposts;
    daily.set(key, bucket);
  };
  for (const post of posts) add(calendarKey(post.date, timeZone), textDetails([post], [], targetIds));
  for (const item of extraX) add(calendarKey(item.publishedAt, timeZone), textDetails([], [item], targetIds));
  return medianDetails([...daily.values()], days);
}

function medianVideoViews(video: VideoOverview, periodDays: number): Totals {
  const daily = Object.values(video.dailyByDay).map((values) => ({
    views: values.views,
    reactions: values.reactions,
    replies: values.replies,
  }));
  const median = medianOfDays(daily, 30);
  return periodDays === 1 ? median : scaleTotals(median, periodDays);
}

/** Fixed number of platform rows per track — see renderOverviewPlatforms. */
const PLATFORM_SLOTS = 4;

const SECONDARY_TEXT_TARGETS = new Set(["site_ru", "site_en", "telegram_stories", "instagram_stories_ru", "instagram_stories"]);

export function renderPlatformMetricFilter(platformMetric: PlatformMetric, periodDays: number, weekOffset: number, view?: string): string {
  const viewParam = view ? `&view=${encodeURIComponent(view)}` : "";
  const base = `/command-center?period=${periodDays}&week_offset=${weekOffset}${viewParam}`;
  const options: Array<[PlatformMetric, string]> = [
    ["reach", "Охват"],
    ["followers", "Подписчики"],
  ];
  return `<div class="platform-metric-filter" role="group" aria-label="Метрика платформ">${options
    .map(
      ([value, label]) =>
        `<a class="platform-metric-btn${value === platformMetric ? " platform-metric-btn--active" : ""}" href="${base}${value === "followers" ? "&metric=followers" : ""}" aria-pressed="${value === platformMetric}">${label}</a>`,
    )
    .join("")}</div>`;
}

function textViewsByDay(
  posts: PipelinePost[],
  timeZone = "Europe/Moscow",
  targetIds: readonly string[] = ORDERED_TARGETS.map((target) => target.id),
): Record<string, number> {
  const days: Record<string, number> = {};
  for (const post of posts) {
    const day = calendarKey(post.date, timeZone);
    if (!day) continue;
    days[day] = (days[day] ?? 0) + postMetricTotals(post, [...targetIds]).views;
  }
  return days;
}

function videoViewsByDay(video: VideoOverview): Record<string, number> {
  return Object.fromEntries(Object.entries(video.dailyByDay).map(([day, values]) => [day, values.views]));
}

function platformViews(key: string, posts: PipelinePost[], xItems: XActivityDashboardItem[]): number {
  const fromPosts = posts.reduce((total, post) => total + targetViews(post, key), 0);
  if (key !== "x") return fromPosts;
  const postsByKey = new Map(posts.map((post) => [post.post_key, post]));
  const activityViews = xItems.reduce((total, item) => {
    const linkedPost = item.linkedPostKey ? postsByKey.get(item.linkedPostKey) : undefined;
    if (!linkedPost) return total + metric(item, "views");
    return total + Math.max(0, metric(item, "views") - targetViews(linkedPost, "x"));
  }, 0);
  return fromPosts + activityViews;
}

function targetViews(post: PipelinePost, target: string): number {
  return (
    getTargetMetric(post, target, "views") + (target === "site_ru" || target === "site_en" ? getTargetMetric(post, target, "bot_views") : 0)
  );
}

function hasTextTargetData(posts: PipelinePost[], target: string): boolean {
  return posts.some((post) => {
    if (post.targets?.[target]?.status === "published") return true;
    if (target === "site_ru" && post.site_ru) return true;
    if (target === "site_en" && post.site_en) return true;
    return Boolean(post.metrics?.[target]);
  });
}

function medianDailyVideoTotals(video: VideoOverview, days: number): Totals {
  const daily = new Map<string, Totals>();
  for (const [key, values] of Object.entries(video.dailyByDay)) {
    const bucket = daily.get(key) ?? emptyTotals();
    bucket.views += values.views;
    bucket.reactions += values.reactions;
    bucket.replies += values.replies;
    daily.set(key, bucket);
  }
  return medianOfDays([...daily.values()], days);
}

function additionalXItems(posts: PipelinePost[], items: XActivityDashboardItem[]): XActivityDashboardItem[] {
  const representedPostKeys = new Set(posts.map((post) => post.post_key).filter((key): key is string => Boolean(key)));
  return items.filter((item) => !item.linkedPostKey || !representedPostKeys.has(item.linkedPostKey));
}

function pipelineTotals(posts: PipelinePost[], targetIds = ORDERED_TARGETS.map((target) => target.id)): Totals {
  return posts.reduce((totals, post) => {
    const metrics = postMetricTotals(post, targetIds);
    totals.views += metrics.views;
    totals.reactions += metrics.likes + metrics.reposts;
    totals.replies += metrics.replies;
    return totals;
  }, emptyTotals());
}

function xTotals(items: XActivityDashboardItem[]): Totals {
  return items.reduce((totals, item) => {
    totals.views += metric(item, "views");
    totals.reactions += metric(item, "interactions");
    totals.replies += metric(item, "replies");
    return totals;
  }, emptyTotals());
}

function combinedTotals(
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  targetIds = ORDERED_TARGETS.map((target) => target.id),
): Totals {
  const core = pipelineTotals(posts, targetIds);
  const x = xTotals(extraX);
  return { views: core.views + x.views, reactions: core.reactions + x.reactions, replies: core.replies + x.replies };
}

function xChartPost(item: XActivityDashboardItem): PipelinePost {
  return {
    post_key: `x-activity:${item.xPostId}`,
    date: item.publishedAt,
    text_en: item.text,
    targets: { x: { status: "published", url: item.url } },
    metrics: {
      x: {
        views: { value: metric(item, "views") },
        likes: { value: metric(item, "interactions") },
        replies: { value: metric(item, "replies") },
      },
    },
  };
}

function metric(item: XActivityDashboardItem, name: string): number {
  return Number(item.metrics[name] ?? 0);
}
