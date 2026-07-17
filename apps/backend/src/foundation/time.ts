/** Single source for zone-aware date math and display, driven by the
 * `timezone`/`timezone_label` configured in studio.yaml (see foundation/config.ts).
 * Every Studio surface that shows or slots a schedule time reads from here. */

/** UTC-minus-local offset in ms for `date` in `timeZone`, read from the actual
 * civil-time offset rather than a fixed constant so it holds for zones that
 * observe daylight saving too. */
export function timezoneOffsetMs(date: Date, timeZone: string): number {
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Cannot resolve ${timeZone} offset`);
  const offset = (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  return match[1] === "+" ? offset : -offset;
}

/** Calendar date `date` reads as in `timeZone`. */
export function zonedDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day) };
}

/** The instant at which the wall clock in `timeZone` reads `clock` (HH:MM) on the given date. */
export function zonedSlot(year: number, month: number, day: number, clock: string, timeZone: string): Date {
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  return new Date(wallClock.getTime() - timezoneOffsetMs(wallClock, timeZone));
}

/** Telegram/dashboard display, e.g. "15.07.2026 18:30 MSK". */
export function formatZonedDateTime(value: string | Date | null, timeZone: string, label: string): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  return `${new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)} ${label}`;
}

/** Sortable "YYYY-MM-DD HH:MM" reading in `timeZone`, for machine-friendly summaries. */
export function formatZonedSortable(value: string, timeZone: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** ISO `[start, end)` bounds of the Monday-start week `offset` weeks from `now`, in `timeZone`. */
export function zonedWeekBounds(offset: number, timeZone: string, now = new Date()): [string, string] {
  const offsetMs = timezoneOffsetMs(now, timeZone);
  const zonedNow = new Date(now.getTime() + offsetMs);
  const weekday = (zonedNow.getUTCDay() + 6) % 7;
  const startWallUtc = Date.UTC(zonedNow.getUTCFullYear(), zonedNow.getUTCMonth(), zonedNow.getUTCDate() - weekday - offset * 7);
  const start = startWallUtc - offsetMs;
  return [new Date(start).toISOString(), new Date(start + 7 * 86_400_000 - 1).toISOString()];
}
