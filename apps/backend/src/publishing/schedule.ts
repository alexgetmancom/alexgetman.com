import { StudioError } from "../foundation/errors.js";
import { zonedDateParts, zonedSlot } from "../foundation/time.js";

// Fixed posting cadence is defined in Moscow time; this is a business-cadence
// choice independent of the display timezone configured in studio.yaml.
const SCHEDULE_TIMEZONE = "Europe/Moscow";

/** Resolves a slot-button clock (`HH:MM` MSK) to today's occurrence, or
 * tomorrow's if today's has already passed. Used by the RU/EN preset
 * scheduling buttons. */
export function scheduleClockToday(clock: string, now = new Date()): Date {
  const today = mskDateParts(now);
  const value = mskSlot(today.year, today.month, today.day, clock);
  return value > now ? value : new Date(value.getTime() + 86_400_000);
}

export function parseManualSchedule(value: string, now = new Date()): Date {
  const input = value.trim().replace(/\s+/g, " ");
  const today = mskDateParts(now);
  let match = input.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) throw new StudioError("common.schedule-parse-error");
    const candidate = mskSlot(today.year, today.month, today.day, `${match[1]?.padStart(2, "0")}:${match[2]}`);
    return candidate > now ? candidate : new Date(candidate.getTime() + 86_400_000);
  }
  match = input.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))? (\d{1,2}):(\d{2})$/);
  if (!match) throw new StudioError("common.schedule-parse-error");
  let year = Number(match[3] ?? today.year);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) throw new StudioError("common.schedule-parse-error");
  let candidate = mskSlot(year, month, day, `${match[4]?.padStart(2, "0")}:${match[5]}`);
  const parts = mskDateParts(candidate);
  if (parts.year !== year || parts.month !== month || parts.day !== day) throw new StudioError("common.schedule-parse-error");
  if (!match[3] && candidate <= now) candidate = mskSlot(++year, month, day, `${match[4]?.padStart(2, "0")}:${match[5]}`);
  if (candidate <= now) throw new StudioError("err.schedule-time-past");
  return candidate;
}

/** Returns a short-lived future timestamp for an explicit "publish now" action.
 * Scheduled commands still reject timestamps that are already in the past. */
export function scheduleNow(now = new Date()): Date {
  return new Date(now.getTime() + 1_000);
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

function mskDateParts(date: Date): { year: number; month: number; day: number } {
  return zonedDateParts(date, SCHEDULE_TIMEZONE);
}

function mskSlot(year: number, month: number, day: number, clock: string): Date {
  return zonedSlot(year, month, day, clock, SCHEDULE_TIMEZONE);
}
