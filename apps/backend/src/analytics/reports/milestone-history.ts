import { and, count, desc, eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { publicationEvents } from "../../db/schema.js";
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
  const where = and(eq(publicationEvents.eventType, "analytics.milestone.reached"), eq(publicationEvents.severity, "info"));
  const total = unsafeDb(backendDb).db.select({ value: count() }).from(publicationEvents).where(where).get()?.value ?? 0;
  const items = unsafeDb(backendDb)
    .db.select({ id: publicationEvents.id, message: publicationEvents.message, reachedAt: publicationEvents.createdAt })
    .from(publicationEvents)
    .where(where)
    .orderBy(desc(publicationEvents.createdAt), desc(publicationEvents.id))
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
