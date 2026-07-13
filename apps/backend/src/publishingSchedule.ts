import { and, asc, eq, gte, inArray, notInArray, or } from "drizzle-orm";
import { type TargetLocale, targetLocale } from "./botTargets.js";
import type { BackendDb } from "./db/client.js";
import {
  drafts,
  type JsonObject,
  postLocales,
  posts,
  publicationPlans,
  publicationSources,
  publishJobs,
  siteJobs,
  siteSourceItems,
} from "./db/schema.js";

const SLOTS: Record<TargetLocale, readonly string[]> = {
  ru: ["10:37", "13:37", "17:37", "20:37", "23:37"],
  en: ["00:37", "03:37", "06:37", "17:37", "20:37"],
};

const MAX_POSTS_PER_DAY = 5;

export function nextPublishingSlot(backendDb: BackendDb, locale: TargetLocale, now = new Date()): Date {
  const values =
    locale === "ru"
      ? backendDb.db
          .select({ value: drafts.scheduledAt })
          .from(drafts)
          .where(and(eq(drafts.status, "scheduled"), gte(drafts.scheduledAt, "")))
          .all()
      : backendDb.db
          .select({ value: drafts.scheduledEnAt })
          .from(drafts)
          .where(and(eq(drafts.status, "scheduled"), gte(drafts.scheduledEnAt, "")))
          .all();
  const occupied = new Set(values.flatMap((row) => (row.value ? [row.value] : [])));
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
  const rows = backendDb.db
    .select({
      id: drafts.id,
      postId: drafts.postId,
      targetsJson: drafts.targetsJson,
      scheduledAt: drafts.scheduledAt,
      scheduledEnAt: drafts.scheduledEnAt,
    })
    .from(drafts)
    .where(eq(drafts.status, "scheduled"))
    .orderBy(asc(drafts.createdAt), asc(drafts.id))
    .all();
  if (rows.length === 0) return 0;

  const assignments = new Map(rows.map((row) => [row.id, { ru: row.scheduledAt, en: row.scheduledEnAt }]));
  for (const locale of ["ru", "en"] as const) {
    const pending = rows.filter((row) => {
      if (!hasLocaleTarget(parseTargets(row.targetsJson), locale)) {
        const assignment = assignments.get(row.id);
        if (assignment) assignment[locale] = null;
        return false;
      }
      const scheduledAt = locale === "ru" ? row.scheduledAt : row.scheduledEnAt;
      return !scheduledAt || new Date(scheduledAt) > now;
    });
    const slots = availableSlots(
      backendDb,
      locale,
      now,
      pending.length,
      rows.map((row) => row.id),
    );
    for (const [index, row] of pending.entries()) {
      const assignment = assignments.get(row.id);
      const slot = slots[index];
      if (assignment && slot) assignment[locale] = slot.toISOString();
    }
  }

  const updatedAt = now.toISOString();
  backendDb.db.transaction((tx) => {
    for (const row of rows) {
      const assignment = assignments.get(row.id);
      if (!assignment) continue;
      tx.update(drafts).set({ scheduledAt: assignment.ru, scheduledEnAt: assignment.en, updatedAt }).where(eq(drafts.id, row.id)).run();
      if (!row.postId) continue;
      syncPublicationSchedule(tx, row.postId, assignment, updatedAt);
      const jobs = tx
        .select({ target: publishJobs.target, payloadJson: publishJobs.payloadJson })
        .from(publishJobs)
        .where(and(eq(publishJobs.postId, row.postId), inArray(publishJobs.status, ["queued", "failed"])))
        .all();
      for (const job of jobs) {
        const publishAt = targetLocale(job.target) === "en" ? assignment.en : assignment.ru;
        const payload = updateSchedulePayload(job.payloadJson, assignment, publishAt);
        tx.update(publishJobs)
          .set({ payloadJson: payload, publishAt, nextAttemptAt: publishAt, updatedAt })
          .where(
            and(eq(publishJobs.postId, row.postId), eq(publishJobs.target, job.target), inArray(publishJobs.status, ["queued", "failed"])),
          )
          .run();
      }
      tx.update(siteJobs)
        .set({ nextAttemptAt: assignment.ru, updatedAt })
        .where(and(eq(siteJobs.postId, row.postId), eq(siteJobs.reason, "publish_ru"), inArray(siteJobs.status, ["queued", "failed"])))
        .run();
      tx.update(siteJobs)
        .set({ nextAttemptAt: assignment.en, updatedAt })
        .where(and(eq(siteJobs.postId, row.postId), eq(siteJobs.reason, "publish_en"), inArray(siteJobs.status, ["queued", "failed"])))
        .run();
    }
  });
  return rows.length;
}

export function formatMsk(value: string | Date | null): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  return `${new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)} MSK`;
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
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) throw new Error("Cannot parse time. Use a valid HH:MM");
    const candidate = mskSlot(today.year, today.month, today.day, `${match[1]?.padStart(2, "0")}:${match[2]}`);
    return candidate > now ? candidate : new Date(candidate.getTime() + 86_400_000);
  }
  match = input.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))? (\d{1,2}):(\d{2})$/);
  if (!match) throw new Error("Cannot parse time. Use HH:MM or DD.MM HH:MM");
  let year = Number(match[3] ?? today.year);
  const month = Number(match[2]);
  const day = Number(match[1]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59)
    throw new Error("Cannot parse time. Use a valid date and time");
  let candidate = mskSlot(year, month, day, `${match[4]?.padStart(2, "0")}:${match[5]}`);
  const parts = mskDateParts(candidate);
  if (parts.year !== year || parts.month !== month || parts.day !== day) throw new Error("Cannot parse time. Use a valid calendar date");
  if (!match[3] && candidate <= now) candidate = mskSlot(++year, month, day, `${match[4]?.padStart(2, "0")}:${match[5]}`);
  if (candidate <= now) throw new Error("Publication time must be in the future");
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

function availableSlots(backendDb: BackendDb, locale: TargetLocale, now: Date, needed: number, rebalancedDraftIds: number[]): Date[] {
  const result: Date[] = [];
  const scheduleColumn = locale === "ru" ? drafts.scheduledAt : drafts.scheduledEnAt;
  const consumedRows = backendDb.db
    .select({ scheduledAt: scheduleColumn, publishMode: drafts.publishMode })
    .from(drafts)
    .where(
      and(
        gte(scheduleColumn, now.toISOString()),
        or(eq(drafts.status, "published"), and(eq(drafts.status, "scheduled"), notInArray(drafts.id, rebalancedDraftIds))),
      ),
    )
    .all();
  for (let offset = 0; offset < 366 && result.length < needed; offset += 1) {
    const date = new Date(now.getTime() + offset * 86_400_000);
    const day = mskDateParts(date);
    const start = mskSlot(day.year, day.month, day.day, "00:00").toISOString();
    const end = new Date(new Date(start).getTime() + 86_400_000).toISOString();
    const consumed = consumedRows.filter((row) => row.scheduledAt != null && row.scheduledAt >= start && row.scheduledAt < end);
    const immediateCount = consumed.filter((row) => row.publishMode === "immediate").length;
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

function syncPublicationSchedule(
  db: BackendDb["db"],
  postId: number,
  assignment: { ru: string | null; en: string | null },
  updatedAt: string,
): void {
  const publishedAt = assignment.ru ?? assignment.en;
  db.update(posts).set({ dateUtc: publishedAt, updatedAt }).where(eq(posts.postId, postId)).run();
  db.update(postLocales)
    .set({ publishedAt: assignment.ru, updatedAt })
    .where(and(eq(postLocales.postId, postId), eq(postLocales.locale, "ru")))
    .run();
  db.update(postLocales)
    .set({ publishedAt: assignment.en, updatedAt })
    .where(and(eq(postLocales.postId, postId), eq(postLocales.locale, "en")))
    .run();
  const plan = db.select({ value: publicationPlans.planJson }).from(publicationPlans).where(eq(publicationPlans.postId, postId)).get();
  if (plan)
    db.update(publicationPlans)
      .set({ planJson: updateSchedulePayload(plan.value, assignment, publishedAt), updatedAt })
      .where(eq(publicationPlans.postId, postId))
      .run();
  const publicationSource = db
    .select({ value: publicationSources.itemJson })
    .from(publicationSources)
    .where(eq(publicationSources.postId, postId))
    .get();
  if (publicationSource)
    db.update(publicationSources)
      .set({ itemJson: updateSchedulePayload(publicationSource.value, assignment, publishedAt), updatedAt })
      .where(eq(publicationSources.postId, postId))
      .run();
  const source = db.select({ messageId: posts.messageId }).from(posts).where(eq(posts.postId, postId)).get();
  if (!source) return;
  const row = db
    .select({ itemJson: siteSourceItems.itemJson })
    .from(siteSourceItems)
    .where(eq(siteSourceItems.messageId, source.messageId))
    .get();
  if (row)
    db.update(siteSourceItems)
      .set({ itemJson: updateSchedulePayload(row.itemJson, assignment, publishedAt), updatedAt })
      .where(eq(siteSourceItems.messageId, source.messageId))
      .run();
}

function updateSchedulePayload(
  value: JsonObject | null,
  assignment: { ru: string | null; en: string | null },
  publishAt: string | null,
): JsonObject {
  return {
    ...(value ?? {}),
    scheduled_at: assignment.ru,
    scheduled_en_at: assignment.en,
    publish_at_ru: assignment.ru,
    publish_at_en: assignment.en,
    date: publishAt ?? assignment.ru ?? assignment.en,
  };
}

function mskSlot(year: number, month: number, day: number, clock: string): Date {
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  return new Date(wallClock.getTime() - timezoneOffsetMs(wallClock, "Europe/Moscow"));
}

function timezoneOffsetMs(date: Date, timeZone: string): number {
  const zone = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Cannot resolve ${timeZone} offset`);
  const offset = (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  return match[1] === "+" ? offset : -offset;
}
