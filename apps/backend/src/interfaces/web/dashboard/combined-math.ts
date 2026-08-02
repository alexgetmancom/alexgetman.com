import { zonedDateParts, zonedSlot } from "../../../foundation/time.js";
import { formatMetricValue } from "./format.js";

export type Totals = { views: number; reactions: number; replies: number };
export type TextDetails = Totals & { reposts: number };

export function formatPlatformDelta(value: number | null): string {
  if (value === null) return "";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value)}%`;
}

export function percentDelta(value: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((value - previous) / previous) * 100);
}

export function metricProgress(value: number, norm: number | null): number | null {
  if (norm === null || norm <= 0) return null;
  return Math.round((value / norm) * 100);
}

export function periodCountLabel(value: number, singular: string, periodDays: number): string {
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

export function periodNormLabel(periodDays: number): string {
  return periodDays === 1 ? "норма дня" : `норма за ${periodDays}д`;
}

export function periodContextLabel(day: Date, periodDays: number, timeZone: string): string {
  if (periodDays !== 1) return `ОХВАТ · ПОСЛЕДНИЕ ${periodDays} ДН.`;
  const parts = zonedDateParts(day, timeZone);
  const months = ["ЯНВ", "ФЕВ", "МАР", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
  return `ОХВАТ · ${parts.day} ${months[parts.month - 1] ?? ""}`;
}

export function periodProjection(value: number, day: Date, periodDays: number, timeZone: string): number | null {
  if (periodDays !== 1 || !isCurrentCalendarDay(day, timeZone)) return null;
  const startParts = zonedDateParts(day, timeZone);
  const start = zonedSlot(startParts.year, startParts.month, startParts.day, "00:00", timeZone);
  const share = Math.max(0.02, Math.min(1, (Date.now() - start.getTime()) / 86_400_000));
  return Math.round(value / share);
}

export function periodPaceLabel(value: number, norm: number | null, day: Date, periodDays: number, timeZone: string): string | null {
  if (norm === null || norm <= 0) return null;
  const remaining = Math.max(0, Math.round(norm - value));
  const projection = periodProjection(value, day, periodDays, timeZone);
  if (value >= norm) return projection === null ? "норма побита" : `норма побита · прогноз ${formatMetricValue(projection)}`;
  return projection === null
    ? `до нормы ${formatMetricValue(remaining)}`
    : `до нормы ${formatMetricValue(remaining)} · прогноз ${formatMetricValue(projection)}`;
}

export function isCurrentCalendarDay(day: Date, timeZone: string): boolean {
  const left = zonedDateParts(day, timeZone);
  const right = zonedDateParts(new Date(), timeZone);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export function scaleTextDetails(value: TextDetails, factor: number): TextDetails {
  return {
    views: value.views * factor,
    reactions: value.reactions * factor,
    replies: value.replies * factor,
    reposts: value.reposts * factor,
  };
}

export function scaleTotals(value: Totals, factor: number): Totals {
  return { views: value.views * factor, reactions: value.reactions * factor, replies: value.replies * factor };
}

export function medianDetails(values: TextDetails[], days: number): TextDetails {
  const padded = [...values];
  while (padded.length < days) padded.push({ views: 0, reactions: 0, replies: 0, reposts: 0 });
  return {
    views: median(padded.map((value) => value.views)),
    reactions: median(padded.map((value) => value.reactions)),
    replies: median(padded.map((value) => value.replies)),
    reposts: median(padded.map((value) => value.reposts)),
  };
}

export function medianOfDays(values: Totals[], days: number): Totals {
  const padded = [...values];
  while (padded.length < days) padded.push(emptyTotals());
  return {
    views: median(padded.map((value) => value.views)),
    reactions: median(padded.map((value) => value.reactions)),
    replies: median(padded.map((value) => value.replies)),
  };
}

export function emptyTotals(): Totals {
  return { views: 0, reactions: 0, replies: 0 };
}

export function calendarKey(value: string | null | undefined, timeZone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle] ?? 0;
  if (ordered.length % 2) return upper;
  return ((ordered[middle - 1] ?? upper) + upper) / 2;
}
