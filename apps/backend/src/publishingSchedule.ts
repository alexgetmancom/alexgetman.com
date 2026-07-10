import { type TargetLocale, targetLocale } from "./botTargets.js";
import type { BackendDb } from "./db/client.js";

const SLOTS: Record<TargetLocale, readonly string[]> = {
  ru: ["10:37", "13:37", "17:37", "20:37", "23:37"],
  en: ["00:37", "03:37", "06:37", "17:37", "20:37"],
};

const MAX_POSTS_PER_DAY = 5;

export function nextPublishingSlot(backendDb: BackendDb, locale: TargetLocale, now = new Date()): Date {
  const column = locale === "ru" ? "scheduled_at" : "scheduled_en_at";
  const occupied = new Set(
    (
      backendDb.sqlite.prepare(`SELECT ${column} AS value FROM drafts WHERE status='scheduled' AND ${column} IS NOT NULL`).all() as Array<{
        value: string;
      }>
    ).map((row) => row.value),
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

/** Re-pack future scheduled drafts after scheduling, cancelling, or changing targets. */
export function rebalanceScheduledDrafts(backendDb: BackendDb, now = new Date()): number {
  const rows = backendDb.sqlite
    .prepare("SELECT id, post_id, targets_json, scheduled_at, scheduled_en_at FROM drafts WHERE status='scheduled' ORDER BY created_at, id")
    .all() as Array<{
    id: number;
    post_id: number | null;
    targets_json: string | null;
    scheduled_at: string | null;
    scheduled_en_at: string | null;
  }>;
  if (rows.length === 0) return 0;

  const assignments = new Map(rows.map((row) => [row.id, { ru: row.scheduled_at, en: row.scheduled_en_at }]));
  for (const locale of ["ru", "en"] as const) {
    const column = locale === "ru" ? "scheduled_at" : "scheduled_en_at";
    const pending = rows.filter((row) => {
      if (!hasLocaleTarget(parseTargets(row.targets_json), locale)) {
        assignments.get(row.id)![locale] = null;
        return false;
      }
      const scheduledAt = row[column];
      return !scheduledAt || new Date(scheduledAt) > now;
    });
    const slots = availableSlots(backendDb, locale, now, pending.length);
    for (const [index, row] of pending.entries()) assignments.get(row.id)![locale] = slots[index]!.toISOString();
  }

  const updatedAt = now.toISOString();
  backendDb.sqlite.transaction(() => {
    for (const row of rows) {
      const assignment = assignments.get(row.id)!;
      backendDb.sqlite
        .prepare("UPDATE drafts SET scheduled_at=?, scheduled_en_at=?, updated_at=? WHERE id=?")
        .run(assignment.ru, assignment.en, updatedAt, row.id);
      if (!row.post_id) continue;
      const jobs = backendDb.sqlite
        .prepare("SELECT target FROM publish_jobs WHERE post_id=? AND status IN ('queued','failed')")
        .all(row.post_id) as Array<{ target: string }>;
      for (const job of jobs) {
        const publishAt = targetLocale(job.target) === "en" ? assignment.en : assignment.ru;
        backendDb.sqlite
          .prepare("UPDATE publish_jobs SET next_attempt_at=?, updated_at=? WHERE post_id=? AND target=? AND status IN ('queued','failed')")
          .run(publishAt, updatedAt, row.post_id, job.target);
      }
      backendDb.sqlite
        .prepare(
          "UPDATE site_jobs SET next_attempt_at=?, updated_at=? WHERE post_id=? AND reason='publish_ru' AND status IN ('queued','failed')",
        )
        .run(assignment.ru, updatedAt, row.post_id);
      backendDb.sqlite
        .prepare(
          "UPDATE site_jobs SET next_attempt_at=?, updated_at=? WHERE post_id=? AND reason='publish_en' AND status IN ('queued','failed')",
        )
        .run(assignment.en, updatedAt, row.post_id);
    }
  })();
  return rows.length;
}

export function formatMsk(value: string | Date | null): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date) + " MSK"
  );
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
  if (!match[3] && candidate <= now)
    candidate = mskSlot(++year, Number(match[2]), Number(match[1]), `${match[4]!.padStart(2, "0")}:${match[5]}`);
  return candidate;
}

function mskDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day) };
}

function availableSlots(backendDb: BackendDb, locale: TargetLocale, now: Date, needed: number): Date[] {
  const column = locale === "ru" ? "scheduled_at" : "scheduled_en_at";
  const result: Date[] = [];
  for (let offset = 0; offset < 366 && result.length < needed; offset += 1) {
    const date = new Date(now.getTime() + offset * 86_400_000);
    const day = mskDateParts(date);
    const start = mskSlot(day.year, day.month, day.day, "00:00").toISOString();
    const end = new Date(new Date(start).getTime() + 86_400_000).toISOString();
    const consumed = backendDb.sqlite
      .prepare(
        `SELECT publish_mode FROM drafts WHERE ${column}>=? AND ${column}<? AND (status='published' OR (status='scheduled' AND ${column}<=?))`,
      )
      .all(start, end, now.toISOString()) as Array<{ publish_mode: string | null }>;
    const immediateCount = consumed.filter((row) => row.publish_mode === "immediate").length;
    const capacity = Math.max(0, MAX_POSTS_PER_DAY - consumed.length);
    const candidates = SLOTS[locale].map((clock) => mskSlot(day.year, day.month, day.day, clock)).filter((slot) => slot > now);
    result.push(...candidates.slice(offset === 0 ? immediateCount : 0, (offset === 0 ? immediateCount : 0) + capacity));
  }
  if (result.length < needed) throw new Error(`No free ${locale.toUpperCase()} publishing slot found`);
  return result;
}

function parseTargets(value: string | null): Record<string, boolean> {
  try {
    const parsed = JSON.parse(value || "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([target, enabled]) => [target, Boolean(enabled)]));
  } catch {
    return {};
  }
}

function hasLocaleTarget(targets: Record<string, boolean>, locale: TargetLocale): boolean {
  return Object.entries(targets).some(([target, enabled]) => enabled && targetLocale(target) === locale);
}

function mskSlot(year: number, month: number, day: number, clock: string): Date {
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, 0));
}
