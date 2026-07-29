import { zonedSlot } from "../../../foundation/time.js";
import { ORDERED_TARGETS } from "./assets.js";
import { formatMetricValue, getMskDateString } from "./format.js";
import { escapeHtml } from "./html.js";
import { getTargetMetric } from "./metrics.js";
import type { ChartMetricName, PipelinePost } from "./types.js";

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
 * clock so "today" is directly comparable with "yesterday".
 */
export function renderDailyComparisonChart(
  todayPosts: PipelinePost[],
  yesterdayPosts: PipelinePost[],
  day: Date,
  timeZone: string,
  now = new Date(),
  targetIds?: string[],
): string {
  const dayStart = zonedSlot(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), "00:00", timeZone);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const yesterdayStart = new Date(dayStart.getTime() - 86_400_000);
  const isToday = now >= dayStart && now < dayEnd;
  const cutoff = isToday ? now : dayEnd;
  const current = sampledViewTimeline(todayPosts, dayStart, cutoff, targetIds);
  const previous = sampledViewTimeline(
    yesterdayPosts,
    yesterdayStart,
    new Date(yesterdayStart.getTime() + (cutoff.getTime() - dayStart.getTime())),
    targetIds,
  );
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
    { name: "Вчера", color: "var(--series-previous)", points: previous, start: yesterdayStart },
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
  return `<div class="metric-chart"><div class="metric-chart__legend"><span><i style="background:var(--series-views)"></i>Сегодня: ${formatMetricValue(currentTotal)}</span><span><i style="background:var(--series-previous)"></i>Вчера к этому времени: ${formatMetricValue(previousTotal)}</span><em>реальные замеры</em></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Сравнение просмотров сегодня и вчера по времени суток">${grid}${paths}${points}${labels}</svg><div class="chart-tooltip" id="chart-tooltip" hidden></div></div>`;
}

type TimelinePoint = { at: Date; value: number };

function sampledViewTimeline(posts: PipelinePost[], start: Date, cutoff: Date, targetIds?: string[]): TimelinePoint[] {
  const events: Array<{ at: Date; key: string; value: number }> = [];
  posts.forEach((post, postIndex) => {
    // The key identifies one (post, target) series so a later sample replaces
    // the earlier one instead of being added to it. Falling back to the post
    // date collapsed two same-day keyless posts into one series and corrupted
    // the running total; the render-local index keeps them apart.
    const postKey = post.post_key ?? post.post_id ?? `index:${postIndex}`;
    for (const [target, metrics] of Object.entries(post.metrics ?? {})) {
      if (targetIds && !targetIds.includes(target)) continue;
      for (const sample of metrics?.views?.samples ?? []) {
        const at = sample.sampled_at ? new Date(sample.sampled_at) : null;
        const value = Number(sample.value);
        if (!at || Number.isNaN(at.getTime()) || !Number.isFinite(value) || at < start || at > cutoff) continue;
        events.push({ at, key: `${postKey}:${target}`, value });
      }
    }
  });
  events.sort((left, right) => left.at.getTime() - right.at.getTime());
  const latest = new Map<string, number>();
  let total = 0;
  const points: TimelinePoint[] = [{ at: start, value: 0 }];
  for (const event of events) {
    total += event.value - (latest.get(event.key) ?? 0);
    latest.set(event.key, event.value);
    points.push({ at: event.at, value: total });
  }
  return points;
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
