import { StudioError } from "../foundation/errors.js";
import { zonedDateParts, zonedSlot } from "../foundation/time.js";

/** Resolves a slot-button clock (`HH:MM` in the configured zone) to today's occurrence, or
 * tomorrow's if today's has already passed. Used by the RU/EN preset
 * scheduling buttons. */
export function scheduleClockToday(clock: string, timeZone: string, now = new Date()): Date {
  const today = zonedDateParts(now, timeZone);
  const value = zonedSlot(today.year, today.month, today.day, clock, timeZone);
  if (value > now) return value;
  const tomorrow = calendarDateAfter(today.year, today.month, today.day);
  return zonedSlot(tomorrow.year, tomorrow.month, tomorrow.day, clock, timeZone);
}

export function parseManualSchedule(value: string, timeZone: string, now = new Date()): Date {
  const input = value.trim().replace(/\s+/g, " ");
  const today = zonedDateParts(now, timeZone);
  let match = input.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) throw new StudioError("common.schedule-parse-error");
    const candidate = parseZonedSlot(today.year, today.month, today.day, `${match[1]?.padStart(2, "0")}:${match[2]}`, timeZone);
    if (candidate > now) return candidate;
    const tomorrow = calendarDateAfter(today.year, today.month, today.day);
    return parseZonedSlot(tomorrow.year, tomorrow.month, tomorrow.day, `${match[1]?.padStart(2, "0")}:${match[2]}`, timeZone);
  }
  match = input.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))? (\d{1,2}):(\d{2})$/);
  if (!match) throw new StudioError("common.schedule-parse-error");
  let year = Number(match[3] ?? today.year);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) throw new StudioError("common.schedule-parse-error");
  let candidate = parseZonedSlot(year, month, day, `${match[4]?.padStart(2, "0")}:${match[5]}`, timeZone);
  const parts = zonedDateParts(candidate, timeZone);
  if (parts.year !== year || parts.month !== month || parts.day !== day) throw new StudioError("common.schedule-parse-error");
  if (!match[3] && candidate <= now) candidate = parseZonedSlot(++year, month, day, `${match[4]?.padStart(2, "0")}:${match[5]}`, timeZone);
  if (candidate <= now) throw new StudioError("err.schedule-time-past");
  return candidate;
}

/** Enforces the application-level contract shared by post and video scheduling. */
export function assertFutureSchedule(value: Date, now = new Date()): void {
  if (Number.isNaN(value.getTime()) || value.getTime() <= now.getTime()) throw new StudioError("err.schedule-time-past");
}

/** Validates a persisted schedule while allowing an internal replan to retain a
 * timestamp that has become due between the original schedule and the replan. */
export function assertValidScheduleDate(value: Date): void {
  if (Number.isNaN(value.getTime())) throw new StudioError("err.schedule-time-past");
}

function parseZonedSlot(year: number, month: number, day: number, clock: string, timeZone: string): Date {
  try {
    return zonedSlot(year, month, day, clock, timeZone);
  } catch {
    throw new StudioError("common.schedule-parse-error");
  }
}

function calendarDateAfter(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}
