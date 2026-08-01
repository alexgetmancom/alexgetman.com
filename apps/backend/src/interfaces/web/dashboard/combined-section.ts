import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { targetLocale } from "../../../botTargets.js";
import { zonedDateParts } from "../../../foundation/time.js";
import { ORDERED_TARGETS, PLATFORM_ICONS, VIDEO_PLATFORM_ICON_KEYS } from "./assets.js";
import { postViewEvents, renderUnifiedDailyChart, renderUnifiedRangeChart } from "./chart.js";
import { formatMetricValue, getMskDateString } from "./format.js";
import { escapeHtml } from "./html.js";
import { getTargetMetric, postMetricTotals } from "./metrics.js";
import { renderPublicationColumns } from "./table.js";
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
  followers: TextPlatformFollowers[];
  rangeStart: Date;
  rangeEnd: Date;
  periodDays: number;
  weekOffset: number;
  timeZone: string;
  mode: OverviewMode;
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
  const video = { views: input.video.totals.views, reactions: input.video.totals.reactions, replies: input.video.totals.replies };
  const previousText =
    periodDays === 1
      ? medianDailyTextTotals(previousPosts, previousExtraX, 30, timeZone)
      : perPeriod(combinedTotals(previousPosts, previousExtraX), periodDays);
  const previousVideoTotals =
    periodDays === 1
      ? medianDailyVideoTotals(input.previousVideo, 30, timeZone)
      : perPeriod(
          {
            views: input.previousVideo.totals.views,
            reactions: input.previousVideo.totals.reactions,
            replies: input.previousVideo.totals.replies,
          },
          periodDays,
        );
  const comparisonLabel = periodDays === 1 ? "vs медиана за 30д" : "vs прошлый период";

  const halves = [
    ...(showText ? [{ name: "Текст", color: TEXT_COLOR, totals: text, previous: previousText }] : []),
    ...(showVideo ? [{ name: "Видео", color: VIDEO_COLOR, totals: video, previous: previousVideoTotals }] : []),
  ];

  return `<section class="pipeline-overview">
    ${renderKpiTable(halves, comparisonLabel)}
    <div class="insights-row">
      ${renderPlatformPanel(input, posts, extraX, showText, showVideo)}
      <div class="chart-panel">
        <div class="section-kicker">${periodDays === 1 ? "Сегодня и вчера" : "Динамика просмотров"}</div>
        ${renderChart(input, posts, extraX, showText, showVideo)}
      </div>
    </div>
    ${renderPublicationColumns(
      showText ? posts : [],
      ORDERED_TARGETS.map((target) => target.id),
      showVideo ? input.video.items : [],
    )}
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
export function renderModeFilter(mode: OverviewMode, periodDays: number, weekOffset: number): string {
  const modes: Array<[OverviewMode, string]> = [
    ["all", "Все"],
    ["text", "Текст"],
    ["video", "Видео"],
  ];
  const base = `/command-center?period=${periodDays}&week_offset=${weekOffset}`;
  return `<div class="mode-filter" role="group" aria-label="Тип контента">${modes
    .map(
      ([value, label]) =>
        `<a class="mode-btn${value === mode ? " mode-btn--active" : ""}" href="${base}${value === "all" ? "" : `&mode=${value}`}">${label}</a>`,
    )
    .join("")}</div>`;
}

type Half = { name: string; color: string; totals: Totals; previous: Totals };

/**
 * The three headline metrics as a small table: one row per metric, one column
 * per half, growth beside each figure.
 *
 * The previous shape was three cards, each repeating "ТЕКСТ / ВИДЕО" under its
 * own pair of numbers — the same two words printed six times on one band. In a
 * table the heading is written once, the columns line up so text and video can
 * actually be read against each other down the page, and the delta gets its own
 * slot instead of hanging off the figure. The numbers stay display-sized: this
 * is still the headline, not a report.
 *
 * The metric name occupies the first of three tracks, so the column rule falls
 * at the same third as the panel and publication splits below it.
 */
function renderKpiTable(halves: Half[], comparisonLabel: string): string {
  const metrics: Array<[keyof Totals, string]> = [
    ["views", "Просмотры"],
    ["reactions", "Реакции"],
    ["replies", "Ответы"],
  ];
  const head = halves
    .map((half) => `<span class="kpi-table__head"><i style="background:${half.color}"></i>${escapeHtml(half.name)}</span>`)
    .join("");
  const rows = metrics
    .map(([metric, label]) => {
      const cells = halves
        .map((half) => {
          const value = half.totals[metric];
          const previous = half.previous[metric];
          const percent = previous > 0 ? Math.round(((value - previous) / previous) * 100) : value > 0 ? 100 : 0;
          const direction = percent >= 0 ? "up" : "down";
          return `<span class="kpi-cell"><strong>${formatMetricValue(value)}</strong><small class="kpi-delta kpi-delta--${direction}">${percent >= 0 ? "↑" : "↓"} ${Math.abs(percent)}%</small></span>`;
        })
        .join("");
      return `<div class="kpi-table__row"><span class="kpi-table__metric">${escapeHtml(label)}</span>${cells}</div>`;
    })
    .join("");
  return `<div class="kpi-table${halves.length === 1 ? " kpi-table--single" : ""}">
    <div class="kpi-table__row kpi-table__row--head"><span class="kpi-table__metric kpi-table__legend">${escapeHtml(comparisonLabel)}</span>${head}</div>
    ${rows}
  </div>`;
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
function renderPlatformPanel(
  input: CombinedSectionInput,
  posts: PipelinePost[],
  extraX: XActivityDashboardItem[],
  showText: boolean,
  showVideo: boolean,
): string {
  const textRows = input.followers.map((platform) => ({
    icon: PLATFORM_ICONS[platform.key.startsWith("threads") ? "threads" : platform.key] ?? "",
    label: platform.label,
    // From the same table the publishing presets read, not from the id: X is EN
    // and Telegram is RU without either saying so in its name, and a bilingual
    // account that adds a platform gets its badge for free.
    locales: localeBadges(targetLocale(platform.key)),
    views: platformViews(platform.key, posts, extraX),
    followers: platform.followers,
    href: `/command-center?period=${input.periodDays}&week_offset=${input.weekOffset}&view=${platform.key}`,
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
  const column = (title: string, color: string, rows: PlatformRow[]) => {
    const followers = rows.reduce((total, row) => total + (row.followers ?? 0), 0);
    const lines = rows
      .map((row) => {
        const name = escapeHtml(row.label);
        const badges = row.locales.map((locale) => `<b class="platform-locale">${escapeHtml(locale)}</b>`).join("");
        const body = `<span class="platform-line__mark"><i>${row.icon}</i>${badges}</span><strong>${formatMetricValue(row.views)}</strong>`;
        return row.href
          ? `<a class="platform-line platform-line--interactive" href="${row.href}" title="${name}" aria-label="${name}">${body}</a>`
          : `<div class="platform-line" title="${name}" aria-label="${name}">${body}</div>`;
      })
      .join("");
    return `<div class="platform-column"><div class="platform-column__head"><i style="background:${color}"></i>${escapeHtml(title)}</div>${lines}<div class="platform-column__foot">подписчики <b>${followers ? formatMetricValue(followers) : "—"}</b></div></div>`;
  };
  return `<aside class="audience-panel platform-panel">
    <div class="section-kicker">Платформы <em>охват</em></div>
    <div class="platform-columns">
      ${showText ? column("Текст", TEXT_COLOR, textRows) : ""}
      ${showVideo ? column("Видео", VIDEO_COLOR, videoRows) : ""}
    </div>
  </aside>`;
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
    const previousPosts = input.dayComparisonData?.posts ?? [];
    const series = [
      ...(showText
        ? [
            {
              name: "Текст",
              color: TEXT_COLOR,
              today: postViewEvents([...posts, ...extraX.map(xChartPost)]),
              yesterday: postViewEvents(previousPosts),
            },
          ]
        : []),
      ...(showVideo
        ? [
            {
              name: "Видео",
              color: VIDEO_COLOR,
              today: input.video.viewEvents as MetricEvent[],
              yesterday: (input.dayComparisonVideo?.viewEvents ?? []) as MetricEvent[],
            },
          ]
        : []),
    ];
    return renderUnifiedDailyChart(series, input.rangeEnd, input.timeZone, new Date(), scale);
  }
  const series = [
    ...(showText ? [{ name: "Текст", color: TEXT_COLOR, byDay: textViewsByDay([...posts, ...extraX.map(xChartPost)]) }] : []),
    ...(showVideo ? [{ name: "Видео", color: VIDEO_COLOR, byDay: videoViewsByDay(input.video) }] : []),
  ];
  return renderUnifiedRangeChart(series, input.rangeStart, input.rangeEnd, scale);
}

function textViewsByDay(posts: PipelinePost[]): Record<string, number> {
  const targetIds = ORDERED_TARGETS.map((target) => target.id);
  const days: Record<string, number> = {};
  for (const post of posts) {
    const day = getMskDateString(post.date);
    days[day] = (days[day] ?? 0) + postMetricTotals(post, targetIds).views;
  }
  return days;
}

function videoViewsByDay(video: VideoOverview): Record<string, number> {
  const days: Record<string, number> = {};
  for (const item of video.items) {
    const day = getMskDateString(item.publishedAt);
    days[day] = (days[day] ?? 0) + item.views;
  }
  return days;
}

/** A target declares one locale; a video platform can carry several. Both end
 * up as the same list of badges so the two columns read alike. */
function localeBadges(locale: string | null): string[] {
  return locale ? [locale.toUpperCase()] : [];
}

function platformViews(key: string, posts: PipelinePost[], extraX: XActivityDashboardItem[]): number {
  const fromPosts = posts.reduce((total, post) => total + getTargetMetric(post, key, "views"), 0);
  return key === "x" ? fromPosts + extraX.reduce((total, item) => total + metric(item, "views"), 0) : fromPosts;
}

function perPeriod(totals: Totals, days: number): Totals {
  if (days <= 1) return totals;
  return { views: totals.views / days, reactions: totals.reactions / days, replies: totals.replies / days };
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

function medianDailyVideoTotals(video: VideoOverview, days: number, timeZone: string): Totals {
  const daily = new Map<string, Totals>();
  for (const item of video.items) {
    const key = calendarKey(item.publishedAt, timeZone);
    if (!key) continue;
    const bucket = daily.get(key) ?? emptyTotals();
    bucket.views += item.views;
    bucket.reactions += item.reactions;
    bucket.replies += item.replies;
    daily.set(key, bucket);
  }
  return medianOfDays([...daily.values()], days);
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
