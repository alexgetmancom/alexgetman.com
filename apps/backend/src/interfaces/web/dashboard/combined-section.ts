import type { XActivityDashboardItem } from "../../../analytics/x-activity-dashboard.js";
import { targetLocale } from "../../../botTargets.js";
import { zonedDateParts, zonedSlot } from "../../../foundation/time.js";
import { ORDERED_TARGETS, PLATFORM_ICONS, platformKey, VIDEO_PLATFORM_ICON_KEYS } from "./assets.js";
import { currentPostViewEvents, postViewEvents, renderUnifiedDailyChart, renderUnifiedRangeChart } from "./chart.js";
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
  const video = { views: input.video.totals.views, reactions: input.video.totals.reactions, replies: input.video.totals.replies };
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
  const halves = [
    ...(showText ? [{ totals: text, previous: previousText }] : []),
    ...(showVideo ? [{ totals: video, previous: previousVideoTotals }] : []),
  ];

  return `<section class="pipeline-overview">
    ${renderKpiTable(halves)}
    <div class="insights-row">
      ${renderPlatformPanel(input, posts, showText, showVideo)}
      <div class="chart-panel">
        <div class="section-kicker">${periodDays === 1 ? "Сегодня и медиана за 30 дней" : "Динамика просмотров"}</div>
        ${renderChart(input, posts, extraX, showText, showVideo)}
      </div>
    </div>
    ${renderPublicationColumns(
      showText ? posts : [],
      ORDERED_TARGETS.map((target) => target.id),
      showVideo ? input.video.items : [],
      { moreUrl: input.publicationDetailsUrl },
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

type Half = { totals: Totals; previous: Totals };

/**
 * The three headline metrics as a small table: one row per metric, one column
 * per half, growth beside each figure.
 *
 * The two feeds are already selected in the global mode control, so this band
 * only needs the metric labels and the figures. The columns line up so text
 * and video can be read against each other down the page, and the delta gets
 * its own slot instead of hanging off the figure. The numbers stay display-
 * sized: this is still the headline, not a report.
 *
 * The metric name occupies the first of three tracks, so the column rule falls
 * at the same third as the panel and publication splits below it.
 */
function renderKpiTable(halves: Half[]): string {
  const metrics: Array<[keyof Totals, string]> = [
    ["views", "Просмотры"],
    ["reactions", "Реакции"],
    ["replies", "Ответы"],
  ];
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
