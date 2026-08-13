import { and, count, desc, eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { postEvents } from "../../db/schema.js";
import { t } from "../../foundation/i18n/index.js";
import { STUDIO_LOCALE_TAGS, type StudioLocale } from "../../foundation/locale.js";

const PAGE_SIZE = 15;

export type MilestoneHistory = {
  text: string;
  total: number;
  pageSize: number;
  items: Array<{ id: number; message: string; reachedAt: string }>;
};

/** Durable audience thresholds in reverse chronological order. These events
 * are the achievement record itself, rather than notification delivery state. */
export function creatorMilestoneHistory(backendDb: BackendDb, offset: number, locale: StudioLocale, timeZone: string): MilestoneHistory {
  const where = and(eq(postEvents.eventType, "analytics.milestone.reached"), eq(postEvents.severity, "info"));
  const total = unsafeDb(backendDb).db.select({ value: count() }).from(postEvents).where(where).get()?.value ?? 0;
  const items = unsafeDb(backendDb)
    .db.select({ id: postEvents.id, message: postEvents.message, reachedAt: postEvents.createdAt })
    .from(postEvents)
    .where(where)
    .orderBy(desc(postEvents.createdAt), desc(postEvents.id))
    .limit(PAGE_SIZE)
    .offset(Math.max(0, offset))
    .all();
  const lines = items.map(
    (item) =>
      `${new Date(item.reachedAt).toLocaleString(STUDIO_LOCALE_TAGS[locale], {
        timeZone,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })} — ${item.message}`,
  );
  return {
    text: lines.length
      ? `${t(locale, "analytics.milestones-title")}\n\n${lines.join("\n")}`
      : `${t(locale, "analytics.milestones-title")}\n\n${t(locale, "analytics.milestones-empty")}`,
    total,
    pageSize: PAGE_SIZE,
    items,
  };
}
