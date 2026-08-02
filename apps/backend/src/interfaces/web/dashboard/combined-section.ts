import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { targetLocale } from "../../../botTargets.js";
import { zonedDateParts, zonedSlot } from "../../../foundation/time.js";
import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey, VIDEO_PLATFORM_ICON_KEYS } from "./assets.js";
import {
  currentPostViewEvents,
  postViewEvents,
  renderOverviewSparkline,
  renderUnifiedDailyChart,
  renderUnifiedRangeChart,
} from "./chart.js";
import { formatMetricValue } from "./format.js";
import { renderHeroCard, renderHeroMicroMetrics, type TextHeroMetrics, type VideoHeroMetrics } from "./hero-section.js";
import { escapeHtml } from "./html.js";
import { getTargetMetric, postMetricTotals } from "./metrics.js";
import { renderPublicationColumns, renderTrackPublicationList } from "./table.js";
import type { PipelineData, PipelinePost } from "./types.js";
import type { MetricEvent, VideoOverview } from "./video-overview.js";

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

export type OverviewMode = "all" | "text" | "video";
export type PlatformMetric = "reach" | "followers";

type Totals = { views: number; reactions: number; replies: number };

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
  mode: OverviewMode;
  platformMetric: PlatformMetric;
  publicationDetailsUrl?: string;
};

const TEXT_COLOR = "var(--series-text)";
const VIDEO_COLOR = "var(--series-video)";

export function renderCombinedSection(input: CombinedSectionInput): string {
  const { mode, periodDays, timeZone } = input;
  const posts = input.data?.posts ?? [];
  const previousPosts = input.previousData?.posts ?? [];
  const extraX = additionalXItems(posts, input.xItems);
  const previousExtraX = additionalXItems(previousPosts, input.previousXItems);

  const showText = mode !== "video";
  const showVideo = mode !== "text";

  const text = combinedTotals(posts, extraX);
  const previousText =
    periodDays === 1 ? medianDailyTextTotals(previousPosts, previousExtraX, 30, timeZone) : combinedTotals(previousPosts, previousExtraX);
  const previousVideoTotals =
    periodDays === 1
      ? medianDailyVideoTotals(input.previousVideo, 30)
      : {
          views: input.previousVideo.totals.views,
          reactions: input.previousVideo.totals.reactions,
          replies: input.previousVideo.totals.replies,
        };
  const textHero = textHeroMetrics(input, posts, extraX, previousPosts, previousExtraX, periodDays, timeZone, text, previousText);
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
    <details class="overview-details">
      <summary>Детальная динамика и публикации</summary>
      <div class="overview-details__body">
        <div class="section-kicker">${periodDays === 1 ? "Сегодня и медиана за 30 дней" : "Динамика просмотров"}</div>
        ${renderChart(input, posts, extraX, showText, showVideo)}
        ${renderPublicationColumns(
          showText ? posts : [],
          ORDERED_TARGETS.map((target) => target.id),
          showVideo ? input.video.items : [],
          { moreUrl: input.publicationDetailsUrl },
        )}
      </div>
    </details>
    <div class="chart-tooltip overview-chart-tooltip" hidden></div>
  </section>`;
}

/**
 * The one global switch. It is a link set rather than a control with state,
 * because every other filter on this screen (period, date, platform) is already
 * a URL — a mode that lived only in the DOM could not be shared or reloaded.
 *
 * Rendered by the shell into the tab bar, next to the period controls, not by
 * the section below it: on its own line it cost a whole row of height to say
 * three words, and it belongs with the other filters rather than above the
 * numbers it filters.
 */
export function renderModeFilter(
  mode: OverviewMode,
  periodDays: number,
  weekOffset: number,
  platformMetric: PlatformMetric = "reach",
): string {
  const modes: Array<[OverviewMode, string]> = [
    ["all", "Все"],
    ["text", "Текст"],
    ["video", "Видео"],
  ];
  const base = `/command-center?period=${periodDays}&week_offset=${weekOffset}${platformMetric === "followers" ? "&metric=followers" : ""}`;
  return `<div class="mode-filter" role="group" aria-label="Тип контента">${modes
    .map(
      ([value, label]) =>
        `<a class="mode-btn${value === mode ? " mode-btn--active" : ""}" href="${base}${value === "all" ? "" : `&mode=${value}`}">${label}</a>`,
    )
    .join("")}</div>`;
}

type OverviewKind = "text" | "video";
type OverviewPlatformRow = {
  key: string;
  label: string;
  locale: string | null;
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
      ? renderTrackPublicationList(
          posts,
          ORDERED_TARGETS.map((target) => target.id),
          [],
          { limit: 4 },
        )
      : renderTrackPublicationList([], [], input.video.items, { limit: 4 });
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
    <div class="overview-publications">
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
  const metricLabel = input.platformMetric === "reach" ? "охват" : "подписчики";
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
            return `<i style="width:${((value / total) * 100).toFixed(3)}%;background:${color};opacity:${opacity.toFixed(2)}"></i>`;
          })
          .join("")
      : `<i class="overview-platforms__empty-segment" style="width:100%;background:${color}"></i>`;
  const visibleRows =
    input.platformMetric === "reach" ? rows.filter((row) => !row.secondary || row.views >= 10) : rows.filter((row) => !row.secondary);
  const hiddenRows = input.platformMetric === "reach" ? rows.filter((row) => row.secondary && row.views < 10) : [];
  const renderRow = (row: OverviewPlatformRow): string => {
    const value = metricValue(row);
    const formatted = value === null ? "—" : formatMetricValue(value);
    const delta = input.platformMetric === "reach" ? formatPlatformDelta(row.delta) : "";
    const body = `<span class="overview-platform__swatch" style="background:${color}"></span><span class="overview-platform__name">${escapeHtml(row.label)}${row.locale ? `<b>${escapeHtml(row.locale.toUpperCase())}</b>` : ""}</span><strong>${formatted}</strong><span class="overview-platform__delta ${row.delta !== null && row.delta >= 0 ? "overview-platform__delta--up" : "overview-platform__delta--down"}">${delta || "\u00a0"}</span>`;
    return row.href
      ? `<a class="overview-platform" href="${escapeHtml(row.href)}" title="${escapeHtml(row.label)}" aria-label="${escapeHtml(row.label)}">${body}</a>`
      : `<div class="overview-platform" title="${escapeHtml(row.label)}" aria-label="${escapeHtml(row.label)}">${body}</div>`;
  };
  const platformRows = visibleRows.map(renderRow).join("");
  const more = hiddenRows.length
    ? `<details class="overview-platforms__more platform-more"><summary>+ Ещё <span>${hiddenRows.length}</span></summary><div class="platform-more__list">${hiddenRows.map(renderRow).join("")}</div></details>`
    : "";
  const filter = showMetricFilter ? renderPlatformMetricFilter(input.platformMetric, input.periodDays, input.weekOffset, input.mode) : "";
  return `<div class="overview-platforms">
    <div class="overview-platforms__header"><div class="overview-kicker">ПЛАТФОРМЫ <em>${metricLabel}</em></div>${filter}</div>
    <div class="overview-platforms__bar-labels"><span>RU</span><span>EN</span></div>
    <div class="overview-platforms__bar">${segments}</div>
    <div class="overview-platforms__legend"><span><b>${formatMetricValue(ru)}</b> · ${total > 0 ? Math.round((ru / total) * 100) : 0}%</span><span>${total > 0 ? Math.round((en / total) * 100) : 0}% · <b>${formatMetricValue(en)}</b></span></div>
    <div class="overview-platforms__rows">${platformRows || '<p class="empty-state">Нет данных по площадкам</p>'}</div>
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

  const rows = input.followers.map((platform) => ({
    key: platform.key,
    label: platform.label,
    locale: targetLocale(platform.key),
    views: platformViews(platform.key, currentPosts, currentX),
    followers: platform.followers,
    delta: percentDelta(platformViews(platform.key, currentPosts, currentX), platformViews(platform.key, comparisonPosts, comparisonX)),
    href: `/command-center?period=${input.periodDays}&week_offset=${input.weekOffset}${input.mode === "all" ? "" : `&mode=${input.mode}`}&view=${encodeURIComponent(platform.key)}`,
    secondary: SECONDARY_TEXT_TARGETS.has(platform.key),
  }));
  const known = new Set(rows.map((row) => row.key));
  const secondary = ORDERED_TARGETS.filter((target) => SECONDARY_TEXT_TARGETS.has(target.id) && !known.has(target.id))
    .filter((target) => hasTextTargetData(currentPosts, target.id))
    .map((target) => ({
      key: target.id,
      label: target.label,
      locale: target.locale,
      views: platformViews(target.id, currentPosts, currentX),
      followers: null,
      delta: percentDelta(platformViews(target.id, currentPosts, currentX), platformViews(target.id, comparisonPosts, comparisonX)),
      href: null,
      secondary: true,
    }));
  return [...rows, ...secondary].sort((left, right) =>
    input.platformMetric === "reach" ? right.views - left.views : (right.followers ?? -1) - (left.followers ?? -1),
  );
}

function formatPlatformDelta(value: number | null): string {
  if (value === null) return "";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value)}%`;
}

function percentDelta(value: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((value - previous) / previous) * 100);
}

function overviewHistory(
  input: CombinedSectionInput,
  kind: OverviewKind,
  currentPosts: PipelinePost[],
  currentX: XActivityDashboardItem[],
): Array<{ label: string; value: number }> {
  const current =
    kind === "text" ? textViewsByDay([...currentPosts, ...currentX.map(xChartPost)], input.timeZone) : videoViewsByDay(input.video);
  if (input.periodDays === 1) {
    const previous =
      kind === "text"
        ? textViewsByDay(
            [
              ...(input.previousData?.posts ?? []),
              ...additionalXItems(input.previousData?.posts ?? [], input.previousXItems).map(xChartPost),
            ],
            input.timeZone,
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
): TextHeroMetrics {
  const currentDetails = textDetails(posts, extraX);
  const hasMedianData = Boolean(input.medianData && ((input.medianData.posts?.length ?? 0) > 0 || input.medianXItems?.length));
  const medianSource = hasMedianData ? (input.medianData?.posts ?? []) : previousPosts;
  const medianExtraX = hasMedianData ? (input.medianXItems ?? []) : previousExtraX;
  const medianDetails =
    hasMedianData && periodDays > 1
      ? scaleTextDetails(medianDailyTextDetails(medianSource, medianExtraX, 30, timeZone), periodDays)
      : periodDays === 1
        ? medianDailyTextDetails(medianSource, medianExtraX, 30, timeZone)
        : textDetails(previousPosts, previousExtraX);
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

function metricProgress(value: number, norm: number | null): number | null {
  if (norm === null || norm <= 0) return null;
  return Math.round((value / norm) * 100);
}

function periodCountLabel(value: number, singular: string, periodDays: number): string {
  const remainder = value % 100;
  const word =
    remainder >= 11 && remainder <= 14
      ? `${singular}ов`
      : value % 10 === 1
        ? singular
        : value % 10 >= 2 && value % 10 <= 4
          ? `${singular}а`
          : `${singular}ов`;
  return periodDays === 1 ? `${formatMetricValue(value)} ${word} сегодня` : `${formatMetricValue(value)} ${word} за ${periodDays}д`;
}

function periodNormLabel(periodDays: number): string {
  return periodDays === 1 ? "норма дня" : `норма за ${periodDays}д`;
}

function periodContextLabel(day: Date, periodDays: number, timeZone: string): string {
  if (periodDays !== 1) return `ОХВАТ · ПОСЛЕДНИЕ ${periodDays} ДН.`;
  const parts = zonedDateParts(day, timeZone);
  const months = ["ЯНВ", "ФЕВ", "МАР", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
  return `ОХВАТ · ${parts.day} ${months[parts.month - 1] ?? ""}`;
}

function periodPaceLabel(value: number, norm: number | null, day: Date, periodDays: number, timeZone: string): string | null {
  if (norm === null || norm <= 0) return null;
  const remaining = Math.max(0, Math.round(norm - value));
  const projection = periodProjection(value, day, periodDays, timeZone);
  if (value >= norm) return projection === null ? "норма побита" : `норма побита · прогноз ${formatMetricValue(projection)}`;
  return projection === null
    ? `до нормы ${formatMetricValue(remaining)}`
    : `до нормы ${formatMetricValue(remaining)} · прогноз ${formatMetricValue(projection)}`;
}

function periodProjection(value: number, day: Date, periodDays: number, timeZone: string): number | null {
  if (periodDays !== 1 || !isCurrentCalendarDay(day, timeZone)) return null;
  const startParts = zonedDateParts(day, timeZone);
  const start = zonedSlot(startParts.year, startParts.month, startParts.day, "00:00", timeZone);
  const share = Math.max(0.02, Math.min(1, (Date.now() - start.getTime()) / 86_400_000));
  return Math.round(value / share);
}

function isCurrentCalendarDay(day: Date, timeZone: string): boolean {
  const left = zonedDateParts(day, timeZone);
  const right = zonedDateParts(new Date(), timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function hasVideoHistory(video: VideoOverview | null | undefined): video is VideoOverview {
  return Boolean(video && (video.items.length > 0 || Object.keys(video.dailyByDay).length > 0));
}

type TextDetails = { views: number; reactions: number; replies: number; reposts: number };

function textDetails(posts: PipelinePost[], extraX: XActivityDashboardItem[]): TextDetails {
  const details = posts.reduce(
    (totals, post) => {
      const metrics = postMetricTotals(
        post,
        ORDERED_TARGETS.map((target) => target.id),
      );
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

function medianDailyTextDetails(posts: PipelinePost[], extraX: XActivityDashboardItem[], days: number, timeZone: string): TextDetails {
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
  for (const post of posts) add(calendarKey(post.date, timeZone), textDetails([post], []));
  for (const item of extraX) add(calendarKey(item.publishedAt, timeZone), textDetails([], [item]));
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

function medianDetails(values: TextDetails[], days: number): TextDetails {
  const padded = [...values];
  while (padded.length < days) padded.push({ views: 0, reactions: 0, replies: 0, reposts: 0 });
  return {
    views: median(padded.map((value) => value.views)),
    reactions: median(padded.map((value) => value.reactions)),
    replies: median(padded.map((value) => value.replies)),
    reposts: median(padded.map((value) => value.reposts)),
  };
}

function scaleTextDetails(value: TextDetails, factor: number): TextDetails {
  return {
    views: value.views * factor,
    reactions: value.reactions * factor,
    replies: value.replies * factor,
    reposts: value.reposts * factor,
  };
}

function scaleTotals(value: Totals, factor: number): Totals {
  return { views: value.views * factor, reactions: value.reactions * factor, replies: value.replies * factor };
}

/**
 * Platforms, in two columns inside one card.
 *
 * The row is a mark and a number, with no platform name. The marks are the
 * same six or seven every day and the operator already knows them; spelled out,
 * "Instagram Reels" was the widest thing in the panel and it pushed the card to
 * half the row, which is space the chart needs. What a name cannot carry and an
 * icon cannot either is the locale — Threads publishes RU and EN through one
 * logo — so only that is written, as a badge. The full name stays in the title
 * attribute and in the accessible label, so nothing is actually lost.
 *
 * Followers move to one summed line under each column. Per platform they were a
 * second unlabelled number next to reach and read as noise; as a column total
 * they still answer "how big is the room" in a single glance.
 */
function renderPlatformPanel(input: CombinedSectionInput, posts: PipelinePost[], showText: boolean, showVideo: boolean): string {
  const textRows = input.followers.map((platform) => ({
    icon: PLATFORM_ICONS[platform.key.startsWith("threads") ? "threads" : platform.key] ?? "",
    label: platform.label,
    // From the same table the publishing presets read, not from the id: X is EN
    // and Telegram is RU without either saying so in its name, and a bilingual
    // account that adds a platform gets its badge for free.
    locales: localeBadges(targetLocale(platform.key)),
    views: platformViews(platform.key, posts, input.xItems),
    followers: platform.followers,
    href: `/command-center?period=${input.periodDays}&week_offset=${input.weekOffset}&view=${platform.key}`,
  }));
  const secondaryTextRows = ORDERED_TARGETS.filter((target) => SECONDARY_TEXT_TARGETS.has(target.id))
    .filter((target) => hasTextTargetData(posts, target.id))
    .map((target) => ({
      icon: PLATFORM_ICONS[platformKey(target.id)] ?? "",
      label: target.label,
      locales: localeBadges(targetLocale(target.id)),
      views: platformViews(target.id, posts, input.xItems),
      followers: null,
      href: null,
    }));
  const videoRows = input.video.platforms.map((platform) => ({
    icon: PLATFORM_ICONS[VIDEO_PLATFORM_ICON_KEYS[platform.target] ?? ""] ?? "",
    label: platform.label,
    locales: platform.locales,
    views: platform.views,
    followers: platform.followers,
    href: null,
  }));
  type PlatformRow = {
    icon: string;
    label: string;
    locales: string[];
    views: number;
    followers: number | null;
    href: string | null;
  };
  const sortRows = (rows: PlatformRow[]): PlatformRow[] =>
    [...rows].sort((left, right) => {
      const leftValue = input.platformMetric === "reach" ? left.views : left.followers;
      const rightValue = input.platformMetric === "reach" ? right.views : right.followers;
      const normalizedLeft = leftValue ?? -1;
      const normalizedRight = rightValue ?? -1;
      return normalizedRight - normalizedLeft || left.label.localeCompare(right.label);
    });
  const renderRows = (rows: PlatformRow[]) =>
    rows
      .map((row) => {
        const name = escapeHtml(row.label);
        const badges = row.locales.map((locale) => `<b class="platform-locale">${escapeHtml(locale)}</b>`).join("");
        const value = input.platformMetric === "reach" ? row.views : row.followers;
        const formattedValue = value === null ? "—" : formatMetricValue(value);
        const body = `<span class="platform-line__mark"><i>${row.icon}</i>${badges}</span><strong>${formattedValue}</strong>`;
        return row.href
          ? `<a class="platform-line platform-line--interactive" href="${row.href}" title="${name}" aria-label="${name}">${body}</a>`
          : `<div class="platform-line" title="${name}" aria-label="${name}">${body}</div>`;
      })
      .join("");
  const column = (title: string, color: string, rows: PlatformRow[], secondaryRows: PlatformRow[] = []) => {
    const visibleSecondary = input.platformMetric === "reach" ? secondaryRows.filter((row) => row.views >= 10) : [];
    const hiddenSecondary = input.platformMetric === "reach" ? secondaryRows.filter((row) => row.views < 10) : [];
    const visibleRows = input.platformMetric === "reach" ? [...rows, ...visibleSecondary] : rows;
    const allRows = input.platformMetric === "reach" ? [...rows, ...secondaryRows] : rows;
    const values = allRows.map((row) => (input.platformMetric === "reach" ? row.views : row.followers));
    const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const hasTotal = values.some((value) => value !== null);
    const label = input.platformMetric === "reach" ? "охват" : "подписчики";
    const more =
      hiddenSecondary.length > 0
        ? `<details class="platform-more"><summary>+ Ещё <span>${hiddenSecondary.length}</span></summary><div class="platform-more__list">${renderRows(sortRows(hiddenSecondary))}</div></details>`
        : "";
    return `<div class="platform-column"><div class="platform-column__head"><i style="background:${color}"></i>${escapeHtml(title)}</div>${renderRows(sortRows(visibleRows))}${more}<div class="platform-column__foot">${label} <b>${hasTotal ? formatMetricValue(total) : "—"}</b></div></div>`;
  };
  return `<aside class="audience-panel platform-panel">
    <div class="platform-panel__head"><div class="section-kicker">Платформы <em>${input.platformMetric === "reach" ? "охват" : "подписчики"}</em></div>${renderPlatformMetricFilter(input.platformMetric, input.periodDays, input.weekOffset, input.mode)}</div>
    <div class="platform-columns">
      ${showText ? column("Текст", TEXT_COLOR, textRows, secondaryTextRows) : ""}
      ${showVideo ? column("Видео", VIDEO_COLOR, videoRows) : ""}
    </div>
  </aside>`;
}

const SECONDARY_TEXT_TARGETS = new Set(["site_ru", "site_en", "telegram_stories", "instagram_stories_ru", "instagram_stories"]);

export function renderPlatformMetricFilter(
  platformMetric: PlatformMetric,
  periodDays: number,
  weekOffset: number,
  mode: OverviewMode = "all",
): string {
  const base = `/command-center?period=${periodDays}&week_offset=${weekOffset}${mode === "all" ? "" : `&mode=${mode}`}`;
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

function renderChart(
  input: CombinedSectionInput,
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  showText: boolean,
  showVideo: boolean,
): string {
  // A single series has nothing to be dwarfed by, so it keeps the absolute axis.
  const scale = showText && showVideo ? "relative" : "absolute";
  if (input.periodDays === 1) {
    const previousPosts = input.previousData?.posts ?? [];
    const previousExtraX = additionalXItems(previousPosts, input.previousXItems);
    const medianText = medianDailyTextTotals(previousPosts, previousExtraX, 30, input.timeZone);
    const medianVideo = medianDailyVideoTotals(input.previousVideo, 30);
    const comparisonDay = input.rangeEnd;
    const comparisonNow = new Date();
    const currentPostSet = [...posts, ...extraX.map(xChartPost)];
    const currentCutoff = dailyCutoff(comparisonDay, input.timeZone, comparisonNow);
    const series = [
      ...(showText
        ? [
            {
              name: "Текст",
              color: TEXT_COLOR,
              today: [...postViewEvents(currentPostSet), ...currentPostViewEvents(currentPostSet, currentCutoff)],
              comparison: benchmarkEvents(medianText.views, comparisonDay, input.timeZone, comparisonNow),
            },
          ]
        : []),
      ...(showVideo
        ? [
            {
              name: "Видео",
              color: VIDEO_COLOR,
              today: input.video.viewEvents as MetricEvent[],
              comparison: benchmarkEvents(medianVideo.views, comparisonDay, input.timeZone, comparisonNow),
            },
          ]
        : []),
    ];
    return renderUnifiedDailyChart(series, comparisonDay, input.timeZone, comparisonNow, scale);
  }
  const series = [
    ...(showText ? [{ name: "Текст", color: TEXT_COLOR, byDay: textViewsByDay([...posts, ...extraX.map(xChartPost)]) }] : []),
    ...(showVideo ? [{ name: "Видео", color: VIDEO_COLOR, byDay: videoViewsByDay(input.video) }] : []),
  ];
  return renderUnifiedRangeChart(series, input.rangeStart, input.rangeEnd, scale);
}

function textViewsByDay(posts: PipelinePost[], timeZone = "Europe/Moscow"): Record<string, number> {
  const targetIds = ORDERED_TARGETS.map((target) => target.id);
  const days: Record<string, number> = {};
  for (const post of posts) {
    const day = calendarKey(post.date, timeZone);
    if (!day) continue;
    days[day] = (days[day] ?? 0) + postMetricTotals(post, targetIds).views;
  }
  return days;
}

function videoViewsByDay(video: VideoOverview): Record<string, number> {
  return Object.fromEntries(Object.entries(video.dailyByDay).map(([day, values]) => [day, values.views]));
}

/** A target declares one locale; a video platform can carry several. Both end
 * up as the same list of badges so the two columns read alike. */
function localeBadges(locale: string | null): string[] {
  return locale ? [locale.toUpperCase()] : [];
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

function medianDailyTextTotals(posts: PipelinePost[], extraX: XActivityDashboardItem[], days: number, timeZone: string): Totals {
  const daily = new Map<string, Totals>();
  const add = (key: string | null, values: Totals) => {
    if (!key) return;
    const bucket = daily.get(key) ?? emptyTotals();
    bucket.views += values.views;
    bucket.reactions += values.reactions;
    bucket.replies += values.replies;
    daily.set(key, bucket);
  };
  for (const post of posts) add(calendarKey(post.date, timeZone), pipelineTotals([post]));
  for (const item of extraX) add(calendarKey(item.publishedAt, timeZone), xTotals([item]));
  return medianOfDays([...daily.values()], days);
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

function benchmarkEvents(total: number, day: Date, timeZone: string, now: Date): MetricEvent[] {
  const parts = zonedDateParts(day, timeZone);
  const start = zonedSlot(parts.year, parts.month, parts.day, "00:00", timeZone);
  const cutoff = dailyCutoff(day, timeZone, now);
  return [
    { at: start, key: "benchmark:start", value: 0 },
    { at: cutoff, key: "benchmark:end", value: Math.max(0, total) },
  ];
}

function dailyCutoff(day: Date, timeZone: string, now: Date): Date {
  const parts = zonedDateParts(day, timeZone);
  const start = zonedSlot(parts.year, parts.month, parts.day, "00:00", timeZone);
  const end = new Date(start.getTime() + 86_400_000);
  return now >= start && now < end ? now : end;
}

/** Days with no publication are real zeros, not missing data: padding to the
 * full window is what keeps a single loud day from becoming the baseline. */
function medianOfDays(values: Totals[], days: number): Totals {
  const padded = [...values];
  while (padded.length < days) padded.push(emptyTotals());
  return {
    views: median(padded.map((value) => value.views)),
    reactions: median(padded.map((value) => value.reactions)),
    replies: median(padded.map((value) => value.replies)),
  };
}

function emptyTotals(): Totals {
  return { views: 0, reactions: 0, replies: 0 };
}

function calendarKey(value: string | null | undefined, timeZone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle] ?? 0;
  if (ordered.length % 2) return upper;
  return ((ordered[middle - 1] ?? upper) + upper) / 2;
}

function additionalXItems(posts: PipelinePost[], items: XActivityDashboardItem[]): XActivityDashboardItem[] {
  const representedPostKeys = new Set(posts.map((post) => post.post_key).filter((key): key is string => Boolean(key)));
  return items.filter((item) => !item.linkedPostKey || !representedPostKeys.has(item.linkedPostKey));
}

function pipelineTotals(posts: PipelinePost[]): Totals {
  const targetIds = ORDERED_TARGETS.map((target) => target.id);
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

function combinedTotals(posts: PipelinePost[], extraX: XActivityDashboardItem[]): Totals {
  const core = pipelineTotals(posts);
  const x = xTotals(extraX);
  return { views: core.views + x.views, reactions: core.reactions + x.reactions, replies: core.replies + x.replies };
}

function xChartPost(item: XActivityDashboardItem): PipelinePost {
  return {
    post_key: `x-activity:${item.xPostId}`,
    date: item.publishedAt,
    targets: { x: { status: "published" } },
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
