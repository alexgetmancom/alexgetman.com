import type { BackendDb } from "./db/client.js";
import type { TargetLocale } from "./botTargets.js";

const SLOTS: Record<TargetLocale, readonly string[]> = {
  ru: ["10:37", "13:37", "17:37", "20:37", "23:37"],
  en: ["00:37", "03:37", "06:37", "17:37", "20:37"],
};

export function nextPublishingSlot(backendDb: BackendDb, locale: TargetLocale, now = new Date()): Date {
  const column = locale === "ru" ? "scheduled_at" : "scheduled_en_at";
  const occupied = new Set(
    (backendDb.sqlite.prepare(`SELECT ${column} AS value FROM drafts WHERE status='scheduled' AND ${column} IS NOT NULL`).all() as Array<{ value: string }>).map((row) => row.value),
  );
  for (let offset = 0; offset < 366; offset += 1) {
    const day = mskDateParts(new Date(now.getTime() + offset * 86_400_000));
    for (const clock of SLOTS[locale]) {
      const slot = mskSlot(day.year, day.month, day.day, clock);
      const iso = slot.toISOString();
      if (slot > now && !occupied.has(iso)) return slot;
    }
  }
  throw new Error(`No free ${locale.toUpperCase()} publishing slot found`);
}

export function formatMsk(value: string | Date | null): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) + " MSK";
}

export function schedulePreset(kind: string, now = new Date()): Date {
  if (kind === "plus30") return new Date(now.getTime() + 30 * 60_000);
  if (kind === "plus60") return new Date(now.getTime() + 60 * 60_000);
  const today = mskDateParts(now);
  if (kind === "today2100") {
    const value = mskSlot(today.year, today.month, today.day, "21:00");
    return value > now ? value : new Date(value.getTime() + 86_400_000);
  }
  if (kind === "tomorrow1000") return mskSlot(today.year, today.month, today.day + 1, "10:00");
  throw new Error(`Unknown schedule preset: ${kind}`);
}

export function parseManualSchedule(value: string, now = new Date()): Date {
  const input = value.trim().replace(/\s+/g, " ");
  const today = mskDateParts(now);
  let match = input.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const candidate = mskSlot(today.year, today.month, today.day, `${match[1]!.padStart(2, "0")}:${match[2]}`);
    return candidate > now ? candidate : new Date(candidate.getTime() + 86_400_000);
  }
  match = input.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))? (\d{1,2}):(\d{2})$/);
  if (!match) throw new Error("Cannot parse time. Use HH:MM or DD.MM HH:MM");
  let year = Number(match[3] ?? today.year);
  let candidate = mskSlot(year, Number(match[2]), Number(match[1]), `${match[4]!.padStart(2, "0")}:${match[5]}`);
  if (!match[3] && candidate <= now) candidate = mskSlot(++year, Number(match[2]), Number(match[1]), `${match[4]!.padStart(2, "0")}:${match[5]}`);
  return candidate;
}

function mskDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day) };
}

function mskSlot(year: number, month: number, day: number, clock: string): Date {
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, 0));
}
