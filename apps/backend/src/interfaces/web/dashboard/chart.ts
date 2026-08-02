import { zonedSlot } from "../../../foundation/time.js";
import { ORDERED_TARGETS } from "./assets.js";
import { formatMetricValue, getMskDateString } from "./format.js";
import { escapeHtml } from "./html.js";
import { getTargetMetric } from "./metrics.js";
import type { ChartMetricName, PipelinePost } from "./types.js";
import type { MetricEvent } from "./video-overview.js";

export function renderWeeklyChart(
  posts: PipelinePost[],
  rangeStart?: Date,
  rangeEnd?: Date,
  targetIds: string[] = ORDERED_TARGETS.map((target) => target.id),
): string {
  const metrics = ["views", "likes", "replies"] as const satisfies readonly ChartMetricName[];
  const colors = { views: "var(--series-views)", likes: "var(--series-likes)", replies: "var(--series-replies)" };
  const labels = { views: "Просмотры", likes: "Реакции", replies: "Ответы" };

  const days: Record<string, Record<ChartMetricName, number>> = {};
  for (const post of posts) {
    const day = getMskDateString(post.date);
    days[day] ??= { views: 0, likes: 0, replies: 0 };
    for (const target of ORDERED_TARGETS.filter((candidate) => targetIds.includes(candidate.id))) {
      for (const metric of metrics) days[day][metric] += getTargetMetric(post, target.id, metric);
    }
  }

  fillCalendarDays(days, rangeStart, rangeEnd);
  const ordered = Object.entries(days).sort((a, b) => a[0].localeCompare(b[0]));
  if (ordered.length === 0) return "";

  const width = 980;
  const height = 138;
  const left = 42;
  const right = 18;
  const top = 14;
  const bottom = 24;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  // One shared axis anchored at zero. Scaling each series to its own min/max
  // put three incomparable lines in the same coordinate space (3 replies could
  // sit above 50k views) and flattened a constant series onto the bottom edge
  // as if it were zero. Exact per-day values for all series stay in the tooltip.
  const axisMax = Math.max(1, ...ordered.flatMap(([, bucket]) => metrics.map((metric) => bucket[metric])));

  const point = (index: number, value: number): [number, number] => [
    left + (plotW * index) / Math.max(1, ordered.length - 1),
    top + plotH - (plotH * value) / axisMax,
  ];

  let grid = "";
  for (let i = 0; i < 5; i++) {
    const y = top + (plotH * i) / 4;
    grid += `<line x1="${left}" y1="${y.toFixed(1)}" x2="${width - right}" y2="${y.toFixed(1)}" class="chart-grid" />`;
  }

  const lines: string[] = [];
  const points: string[] = [];
  for (const metric of metrics) {
    const metricPoints: string[] = [];
    ordered.forEach(([day, bucket], index) => {
      const [x, y] = point(index, bucket[metric]);
      metricPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      const dayValues = metrics.map((item) => `${labels[item]}: ${formatMetricValue(bucket[item])}`).join(" · ");
      const tooltip = `${formatDateLabel(day)} · ${dayValues}`;
      points.push(
        `<circle class="chart-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="${colors[metric]}" />` +
          `<circle class="chart-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" data-tooltip="${escapeHtml(tooltip)}" />`,
      );
    });
    lines.push(
      `<polyline class="chart-line" points="${metricPoints.join(" ")}" fill="none" stroke="${colors[metric]}" stroke-width="2.2" />`,
    );
  }

  const labelStep = Math.max(1, Math.ceil((ordered.length - 1) / 6));
  const xLabels = ordered
    .map(([day], index) => {
      if (index !== 0 && index !== ordered.length - 1 && index % labelStep !== 0) return "";
      const [x] = point(index, 0);
      return `<text x="${x.toFixed(1)}" y="${height - 7}" text-anchor="middle">${escapeHtml(formatDateLabel(day))}</text>`;
    })
    .join("");
  const legend = metrics
    .map((metric) => {
      const sum = ordered.reduce((acc, [, bucket]) => acc + bucket[metric], 0);
      return `<span><i style="background:${colors[metric]}"></i>${labels[metric]}: ${formatMetricValue(sum)}</span>`;
    })
    .join("");

  return `
    <div class="metric-chart">
      <div class="metric-chart__legend">${legend}</div>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="График метрик за выбранный период">${grid}${lines.join("")}${points.join("")}${xLabels}</svg>
      <div class="chart-tooltip" id="chart-tooltip" hidden></div>
    </div>
  `;
}

/**
 * A one-day view uses immutable collection samples rather than pretending that
 * we know the value for every hour. Both series are clipped to the same wall
 * clock when the caller supplies real comparison samples; the dashboard uses
 * the same shape for its median benchmark.
 */
export function renderDailyComparisonChart(
  todayPosts: PipelinePost[],
  yesterdayPosts: PipelinePost[],
  day: Date,
  timeZone: string,
  now = new Date(),
  targetIds?: string[],
  benchmarkTotal?: number,
): string {
  const dayStart = zonedSlot(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), "00:00", timeZone);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const yesterdayStart = new Date(dayStart.getTime() - 86_400_000);
  const isToday = now >= dayStart && now < dayEnd;
  const cutoff = isToday ? now : dayEnd;
  const current = sampledViewTimeline(todayPosts, dayStart, cutoff, targetIds);
  const previous =
    benchmarkTotal === undefined
      ? sampledViewTimeline(
          yesterdayPosts,
          yesterdayStart,
          new Date(yesterdayStart.getTime() + (cutoff.getTime() - dayStart.getTime())),
          targetIds,
        )
      : benchmarkTimeline(benchmarkTotal, dayStart, cutoff);
  if (current.length <= 1 && previous.length <= 1)
    return `<div class="metric-chart metric-chart--empty"><div class="metric-chart__legend"><span>Замеры появятся через час после публикации</span></div></div>`;

  const width = 980;
  const height = 170;
  const left = 18;
  const right = 18;
  const top = 20;
  const bottom = 28;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const max = Math.max(1, ...current.map((point) => point.value), ...previous.map((point) => point.value));
  const x = (at: Date, start: Date) => left + (plotW * (at.getTime() - start.getTime())) / 86_400_000;
  const y = (value: number) => top + plotH - (plotH * value) / max;
  let grid = "";
  for (let i = 0; i < 4; i++) {
    const gridY = top + (plotH * i) / 3;
    grid += `<line x1="${left}" y1="${gridY.toFixed(1)}" x2="${width - right}" y2="${gridY.toFixed(1)}" class="chart-grid" />`;
  }
  const series = [
    { name: "Сегодня", color: "var(--series-views)", points: current, start: dayStart },
    {
      name: benchmarkTotal === undefined ? "Вчера" : "Медиана за 30 дней",
      color: "var(--series-previous)",
      points: previous,
      start: benchmarkTotal === undefined ? yesterdayStart : dayStart,
    },
  ];
  const paths = series
    .map(
      ({ color, points, start }) =>
        `<polyline class="chart-line" points="${points.map((point) => `${x(point.at, start).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.4" />`,
    )
    .join("");
  const points = series
    .flatMap(({ name, color, points, start }) =>
      points.slice(1).map((point) => {
        const tooltip = `${name}, ${clockLabel(point.at, timeZone)} · ${formatMetricValue(point.value)} просмотров`;
        return `<circle class="chart-point" cx="${x(point.at, start).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="3" fill="${color}" /><circle class="chart-hit" cx="${x(point.at, start).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="10" data-tooltip="${escapeHtml(tooltip)}" />`;
      }),
    )
    .join("");
  const labels = [0, 6, 12, 18, 24]
    .map(
      (hour) =>
        `<text x="${(left + (plotW * hour) / 24).toFixed(1)}" y="${height - 7}" text-anchor="middle">${String(hour).padStart(2, "0")}:00</text>`,
    )
    .join("");
  const currentTotal = current.at(-1)?.value ?? 0;
  const previousTotal = previous.at(-1)?.value ?? 0;
  const comparisonLabel = benchmarkTotal === undefined ? "Вчера к этому времени" : "Медиана за 30 дней";
  return `<div class="metric-chart"><div class="metric-chart__legend"><span><i style="background:var(--series-views)"></i>Сегодня: ${formatMetricValue(currentTotal)}</span><span><i style="background:var(--series-previous)"></i>${comparisonLabel}: ${formatMetricValue(previousTotal)}</span><em>${benchmarkTotal === undefined ? "реальные замеры" : "ориентир по дневной медиане"}</em></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Сравнение просмотров сегодня и медианы за 30 дней по времени суток">${grid}${paths}${points}${labels}</svg><div class="chart-tooltip" id="chart-tooltip" hidden></div></div>`;
}

/** One half of the unified overview: current period against one benchmark. */
export type UnifiedSeries = { name: string; color: string; today: MetricEvent[]; comparison: MetricEvent[] };

/**
 * Text and video on one time axis.
 *
 * Both the absolute and relative views remain available here because this is
 * the detailed chart where the operator compares the shape of two series. The
 * compact overview sparkline below deliberately uses one fixed absolute cap.
 */
export function renderUnifiedDailyChart(
  series: UnifiedSeries[],
  day: Date,
  timeZone: string,
  now = new Date(),
  defaultScale: "absolute" | "relative" = "relative",
): string {
  const dayStart = zonedSlot(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), "00:00", timeZone);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const isToday = now >= dayStart && now < dayEnd;
  const cutoff = isToday ? now : dayEnd;

  const resolved = series.map((item) => ({
    ...item,
    todayPoints: cumulativeTimeline(item.today, dayStart, cutoff),
    comparisonPoints: cumulativeTimeline(item.comparison, dayStart, cutoff),
  }));
  const hasData = resolved.some((item) => item.todayPoints.length > 1 || item.comparisonPoints.length > 1);
  if (!hasData)
    return `<div class="metric-chart metric-chart--empty"><div class="metric-chart__legend"><span>Замеры появятся через час после публикации</span></div></div>`;

  const width = 980;
  const height = 170;
  const left = 18;
  const right = 18;
  const top = 20;
  const bottom = 28;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const seriesMax = resolved.map((item) =>
    Math.max(1, ...item.todayPoints.map((point) => point.value), ...item.comparisonPoints.map((point) => point.value)),
  );
  const sharedMax = Math.max(1, ...seriesMax);

  const x = (at: Date, start: Date) => left + (plotW * (at.getTime() - start.getTime())) / 86_400_000;
  const y = (value: number, max: number) => top + plotH - (plotH * value) / max;

  let grid = "";
  for (let index = 0; index < 4; index += 1) {
    const gridY = top + (plotH * index) / 3;
    grid += `<line x1="${left}" y1="${gridY.toFixed(1)}" x2="${width - right}" y2="${gridY.toFixed(1)}" class="chart-grid" />`;
  }
  const hourLabels = [0, 6, 12, 18, 24]
    .map(
      (hour) =>
        `<text x="${(left + (plotW * hour) / 24).toFixed(1)}" y="${height - 7}" text-anchor="middle">${String(hour).padStart(2, "0")}:00</text>`,
    )
    .join("");

  const plot = (scale: "absolute" | "relative"): string => {
    const shapes = resolved
      .map((item, index) => {
        const max = scale === "relative" ? (seriesMax[index] ?? 1) : sharedMax;
        const line = (points: TimelinePoint[], start: Date, dashed: boolean) =>
          points.length
            ? `<polyline class="chart-line" points="${points.map((point) => `${x(point.at, start).toFixed(1)},${y(point.value, max).toFixed(1)}`).join(" ")}" fill="none" stroke="${item.color}" stroke-width="2.4"${dashed ? ' stroke-dasharray="5 5" opacity=".55"' : ""} />`
            : "";
        const dots = item.todayPoints
          .slice(1)
          .map((point) => {
            const tooltip = `${item.name}, ${clockLabel(point.at, timeZone)} · ${formatMetricValue(point.value)} просмотров`;
            const cx = x(point.at, dayStart).toFixed(1);
            const cy = y(point.value, max).toFixed(1);
            return `<circle class="chart-point" cx="${cx}" cy="${cy}" r="3" fill="${item.color}" /><circle class="chart-hit" cx="${cx}" cy="${cy}" r="10" data-tooltip="${escapeHtml(tooltip)}" />`;
          })
          .join("");
        return `${line(item.comparisonPoints, dayStart, true)}${line(item.todayPoints, dayStart, false)}${dots}`;
      })
      .join("");
    return `<svg class="chart-view chart-view--${scale}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Просмотры текста и видео за сегодня против медианы за 30 дней">${grid}${shapes}${hourLabels}</svg>`;
  };

  const legend = resolved
    .map((item) => {
      const today = item.todayPoints.at(-1)?.value ?? 0;
      const comparison = item.comparisonPoints.at(-1)?.value ?? 0;
      return `<span><i style="background:${item.color}"></i>${escapeHtml(item.name)}: ${formatMetricValue(today)} <em>медиана ${formatMetricValue(comparison)}</em></span>`;
    })
    .join("");

  return `<div class="metric-chart metric-chart--dual" data-scale="${defaultScale}">
      <div class="metric-chart__head">
        <div class="metric-chart__legend">${legend}<em>пунктир — медиана за 30 дней</em></div>
        ${scaleToggle(defaultScale)}
      </div>
      ${plot("absolute")}${plot("relative")}
      <div class="chart-tooltip" id="chart-tooltip" hidden></div>
    </div>`;
}

/** The multi-day counterpart: one point per calendar day, per series. */
export function renderUnifiedRangeChart(
  series: Array<{ name: string; color: string; byDay: Record<string, number> }>,
  rangeStart: Date,
  rangeEnd: Date,
  defaultScale: "absolute" | "relative" = "relative",
): string {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(rangeStart.getUTCFullYear(), rangeStart.getUTCMonth(), rangeStart.getUTCDate()));
  const last = Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), rangeEnd.getUTCDate());
  while (cursor.getTime() <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (days.length < 2) return "";

  const width = 980;
  const height = 170;
  const left = 42;
  const right = 18;
  const top = 16;
  const bottom = 26;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const seriesMax = series.map((item) => Math.max(1, ...days.map((day) => item.byDay[day] ?? 0)));
  const sharedMax = Math.max(1, ...seriesMax);
  const x = (index: number) => left + (plotW * index) / Math.max(1, days.length - 1);
  const y = (value: number, max: number) => top + plotH - (plotH * value) / max;

  let grid = "";
  for (let index = 0; index < 5; index += 1) {
    const gridY = top + (plotH * index) / 4;
    grid += `<line x1="${left}" y1="${gridY.toFixed(1)}" x2="${width - right}" y2="${gridY.toFixed(1)}" class="chart-grid" />`;
  }
  const labelStep = Math.max(1, Math.ceil((days.length - 1) / 6));
  const xLabels = days
    .map((day, index) =>
      index !== 0 && index !== days.length - 1 && index % labelStep !== 0
        ? ""
        : `<text x="${x(index).toFixed(1)}" y="${height - 7}" text-anchor="middle">${escapeHtml(formatDateLabel(day))}</text>`,
    )
    .join("");

  const plot = (scale: "absolute" | "relative"): string => {
    const shapes = series
      .map((item, seriesIndex) => {
        const max = scale === "relative" ? (seriesMax[seriesIndex] ?? 1) : sharedMax;
        const points = days.map((day, index) => `${x(index).toFixed(1)},${y(item.byDay[day] ?? 0, max).toFixed(1)}`).join(" ");
        const dots = days
          .map((day, index) => {
            const value = item.byDay[day] ?? 0;
            const tooltip = `${formatDateLabel(day)} · ${item.name}: ${formatMetricValue(value)}`;
            const cx = x(index).toFixed(1);
            const cy = y(value, max).toFixed(1);
            return `<circle class="chart-point" cx="${cx}" cy="${cy}" r="2.8" fill="${item.color}" /><circle class="chart-hit" cx="${cx}" cy="${cy}" r="10" data-tooltip="${escapeHtml(tooltip)}" />`;
          })
          .join("");
        return `<polyline class="chart-line" points="${points}" fill="none" stroke="${item.color}" stroke-width="2.2" />${dots}`;
      })
      .join("");
    return `<svg class="chart-view chart-view--${scale}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Просмотры текста и видео по дням">${grid}${shapes}${xLabels}</svg>`;
  };

  const legend = series
    .map((item) => {
      const sum = days.reduce((total, day) => total + (item.byDay[day] ?? 0), 0);
      return `<span><i style="background:${item.color}"></i>${escapeHtml(item.name)}: ${formatMetricValue(sum)}</span>`;
    })
    .join("");

  return `<div class="metric-chart metric-chart--dual" data-scale="${defaultScale}">
      <div class="metric-chart__head">
        <div class="metric-chart__legend">${legend}</div>
        ${scaleToggle(defaultScale)}
      </div>
      ${plot("absolute")}${plot("relative")}
      <div class="chart-tooltip" id="chart-tooltip" hidden></div>
    </div>`;
}

/** Compact daily bars for the editorial overview. Unlike the detailed chart,
 * this view answers only "how did the selected day or period compare with its
 * own recent shape?" so it can live inside each text/video column. */
export const OVERVIEW_SPARK_MAX = 50_000;

export function renderOverviewSparkline(
  points: Array<{ label: string; value: number }>,
  color: string,
  ariaLabel: string,
  leftLabel: string,
  rightLabel: string,
): string {
  if (!points.length) return "";

  const width = 560;
  const height = 58;
  const barGap = 3;
  const barWidth = (width - (points.length - 1) * barGap) / points.length;
  const values = points.map((point) => Math.max(0, point.value));
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  const clippedAverage = Math.min(OVERVIEW_SPARK_MAX, average);
  const averageY = height - (clippedAverage / OVERVIEW_SPARK_MAX) * height;
  const bars = points
    .map((point, index) => {
      const value = values[index] ?? 0;
      const overCap = value > OVERVIEW_SPARK_MAX;
      const visibleValue = Math.min(value, OVERVIEW_SPARK_MAX);
      const barHeight = Math.max(1, (visibleValue / OVERVIEW_SPARK_MAX) * height);
      const x = index * (barWidth + barGap);
      const y = height - barHeight;
      const opacity = overCap
        ? 1
        : index === points.length - 1
          ? 1
          : Math.max(0.24, 0.72 - ((points.length - 1 - index) / Math.max(1, points.length)) * 0.35);
      const barClass = `overview-spark__bar${overCap ? " overview-spark__bar--over-cap" : ""}`;
      const tooltip = `${escapeHtml(point.label)} · ${formatMetricValue(value)}`;
      return `<g><rect class="${barClass}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="2" fill="${color}" opacity="${opacity.toFixed(2)}"/><rect class="chart-hit" x="${Math.max(0, x - barGap / 2).toFixed(2)}" y="0" width="${(barWidth + barGap).toFixed(2)}" height="${height}" data-tooltip="${tooltip}"/></g>`;
    })
    .join("");

  return `<div class="overview-spark">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(ariaLabel)}">
      <line class="overview-spark__cap" x1="0" y1="0" x2="${width}" y2="0"/>
      <text class="overview-spark__cap-label" x="${width}" y="9" text-anchor="end">50k</text>
      <line class="overview-spark__average" x1="0" y1="${averageY.toFixed(2)}" x2="${width}" y2="${averageY.toFixed(2)}"/>
      ${bars}
    </svg>
    <div class="overview-spark__footer"><span>${escapeHtml(leftLabel)}</span><span>среднее <b>${formatMetricValue(Math.round(average))}</b> · ${escapeHtml(rightLabel)} <b>${formatMetricValue(points.at(-1)?.value ?? 0)}</b></span></div>
  </div>`;
}

function scaleToggle(active: "absolute" | "relative"): string {
  const button = (scale: "absolute" | "relative", label: string, title: string) =>
    `<button type="button" class="chart-scale__btn${scale === active ? " chart-scale__btn--active" : ""}" data-scale="${scale}" aria-pressed="${scale === active}" title="${escapeHtml(title)}">${label}</button>`;
  return `<div class="chart-scale" role="group" aria-label="Масштаб графика">${button("absolute", "abs", "Общая ось: видно реальное соотношение")}${button("relative", "%", "Каждая линия к своему пику: видно форму дня")}</div>`;
}

type TimelinePoint = { at: Date; value: number };

/** Raw view samples of a post set, in the shape the video read model also
 * produces, so both halves of the overview fold through one code path. */
export function postViewEvents(posts: PipelinePost[], targetIds?: string[]): MetricEvent[] {
  const events: MetricEvent[] = [];
  posts.forEach((post, postIndex) => {
    // The key identifies one (post, target) series so a later sample replaces
    // the earlier one instead of being added to it. Falling back to the post
    // date collapsed two same-day keyless posts into one series and corrupted
    // the running total; the render-local index keeps them apart.
    const postKey = pipelinePostKey(post, postIndex);
    for (const [target, metrics] of Object.entries(post.metrics ?? {})) {
      if (targetIds && !targetIds.includes(target)) continue;
      for (const sample of metrics?.views?.samples ?? []) {
        const at = sample.sampled_at ? new Date(sample.sampled_at) : null;
        const value = Number(sample.value);
        if (!at || Number.isNaN(at.getTime()) || !Number.isFinite(value)) continue;
        events.push({ at, key: `${postKey}:${target}`, value });
      }
    }
  });
  return events;
}

/** Adds the current read-model value so a chart does not end below its KPI
 * when a post has a current metric but no sample in the selected window. */
export function currentPostViewEvents(posts: PipelinePost[], at: Date, targetIds?: string[]): MetricEvent[] {
  const events: MetricEvent[] = [];
  posts.forEach((post, postIndex) => {
    const postKey = pipelinePostKey(post, postIndex);
    for (const [target, metrics] of Object.entries(post.metrics ?? {})) {
      if (targetIds && !targetIds.includes(target)) continue;
      const value = Number(metrics?.views?.value);
      if (!Number.isFinite(value)) continue;
      events.push({ at, key: `${postKey}:${target}`, value });
    }
  });
  return events;
}

function pipelinePostKey(post: PipelinePost, postIndex: number): string | number {
  return post.post_key ?? post.post_id ?? `index:${postIndex}`;
}

/** Folds immutable observations into a running total: a later sample of the
 * same key replaces the earlier one rather than adding to it. */
export function cumulativeTimeline(events: MetricEvent[], start: Date, cutoff: Date): TimelinePoint[] {
  const windowed = events
    .filter((event) => event.at >= start && event.at <= cutoff)
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  const latest = new Map<string, number>();
  let total = 0;
  const points: TimelinePoint[] = [{ at: start, value: 0 }];
  for (const event of windowed) {
    total += event.value - (latest.get(event.key) ?? 0);
    latest.set(event.key, event.value);
    points.push({ at: event.at, value: total });
  }
  return points;
}

function sampledViewTimeline(posts: PipelinePost[], start: Date, cutoff: Date, targetIds?: string[]): TimelinePoint[] {
  return cumulativeTimeline(postViewEvents(posts, targetIds), start, cutoff);
}

function benchmarkTimeline(total: number, start: Date, cutoff: Date): TimelinePoint[] {
  return [
    { at: start, value: 0 },
    { at: cutoff, value: Math.max(0, total) },
  ];
}

function clockLabel(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(value);
}

function fillCalendarDays(days: Record<string, Record<ChartMetricName, number>>, start?: Date, end?: Date): void {
  if (!start || !end) return;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor.getTime() <= last) {
    const key = cursor.toISOString().slice(0, 10);
    days[key] ??= { views: 0, likes: 0, replies: 0 };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function formatDateLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}
