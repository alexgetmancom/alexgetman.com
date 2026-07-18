import { and, asc, eq, gte, inArray, notExists, notInArray, or, sql } from "drizzle-orm";
import type { Bot } from "grammy";
import { refreshPostControlCard } from "../../bot/progress.js";
import type { BackendDb } from "../../db/client.js";
import { alertDedup, drafts, postEvents } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import {
  notifyFinalVideoFailure,
  refreshVideoControlCard,
  sendStudioCompletion,
  sendStudioReminder,
  sendVideoReminder,
} from "./video-notifications.js";

const TELEGRAM_EVENT_TYPES = [
  "delivery.post.settled",
  "publish.job.claimed",
  "publish.job.published",
  "publish.job.failed",
  "publish.job.retry",
  "video.reminder.due",
  "video.target.failed",
  "video.job.completed",
  "video.job.failed",
  "studio.notification.reminder.due",
  "delivery.post.completed",
  "delivery.video.completed",
  "analytics.milestone.reached",
];
// Telegram is an immediate interface, not an archival notification transport.
// Older undelivered events remain in the durable audit journal, but must never
// be replayed after a restart and drown current reminders/completions. A
// reminder anchored to a specific moment ("5 minutes before") is meaningless
// hours late, so it keeps a short window. A failure or completion describes
// something that already happened and must survive an outage or deploy that
// outlasts the short window, so it gets a much longer one.
const REMINDER_EVENT_TYPES = ["video.reminder.due", "studio.notification.reminder.due"];
const REMINDER_EVENT_MAX_AGE_MS = 30 * 60 * 1000;
const OUTCOME_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Consumes durable domain events and renders Telegram-only side effects once. */
export async function consumeTelegramEvents(backendDb: BackendDb, bot: Bot | null, config: BackendConfig): Promise<number> {
  if (!bot) return 0;
  // Filter in SQL, before LIMIT. Filtering after LIMIT starves new events once
  // the first page is occupied by historically delivered Telegram effects.
  const delivered = backendDb.db
    .select({ one: sql<number>`1` })
    .from(alertDedup)
    .where(eq(alertDedup.alertKey, sql<string>`'telegram:event:' || ${postEvents.id}`));
  const events = backendDb.db
    .select()
    .from(postEvents)
    .where(
      and(
        inArray(postEvents.eventType, TELEGRAM_EVENT_TYPES),
        or(
          and(
            inArray(postEvents.eventType, REMINDER_EVENT_TYPES),
            gte(postEvents.createdAt, new Date(Date.now() - REMINDER_EVENT_MAX_AGE_MS).toISOString()),
          ),
          and(
            notInArray(postEvents.eventType, REMINDER_EVENT_TYPES),
            gte(postEvents.createdAt, new Date(Date.now() - OUTCOME_EVENT_MAX_AGE_MS).toISOString()),
          ),
        ),
        notExists(delivered),
      ),
    )
    .orderBy(asc(postEvents.createdAt), asc(postEvents.id))
    .limit(50)
    .all();
  let handled = 0;
  for (const event of events) {
    if (wasDelivered(backendDb, event.id)) continue;
    const details = eventDetails(event.detailsJson);
    const videoDraftId = numberDetail(details, "videoDraftId");
    const videoTargetId = numberDetail(details, "videoTargetId");
    if (event.eventType === "studio.notification.reminder.due") {
      await sendStudioReminder(backendDb, bot, { ...event, detailsJson: details });
    } else if (event.eventType === "delivery.post.completed" || event.eventType === "delivery.video.completed") {
      await sendStudioCompletion(backendDb, bot, { ...event, detailsJson: details });
    } else if (event.eventType === "analytics.milestone.reached") {
      for (const adminId of config.ADMIN_IDS) await bot.api.sendMessage(adminId, event.message);
    } else if (event.eventType === "delivery.post.settled" || event.eventType.startsWith("publish.job.")) {
      const postId = numberDetail(details, "post_id") ?? postIdFromRef(event.postKey);
      const draft = postId == null ? null : backendDb.db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, postId)).get();
      if (draft) await refreshPostControlCard(backendDb, bot, draft.id);
    } else if (event.eventType === "video.reminder.due" && videoDraftId != null)
      await sendVideoReminder(backendDb, bot, videoDraftId, videoTargetId, config.VIDEO_REMINDER_MINUTES);
    else if (event.eventType === "video.target.failed" && videoDraftId != null)
      await notifyFinalVideoFailure(backendDb, bot, videoDraftId, videoTargetId);
    else if (videoDraftId != null) await refreshVideoControlCard(backendDb, bot, videoDraftId);
    markDelivered(backendDb, event.id);
    handled += 1;
  }
  return handled;
}

function postIdFromRef(value: string | null): number | null {
  const match = value?.match(/^post:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function wasDelivered(backendDb: BackendDb, eventId: number): boolean {
  return (
    backendDb.db
      .select()
      .from(alertDedup)
      .where(eq(alertDedup.alertKey, `telegram:event:${eventId}`))
      .get() != null
  );
}

function markDelivered(backendDb: BackendDb, eventId: number): void {
  backendDb.db
    .insert(alertDedup)
    .values({ alertKey: `telegram:event:${eventId}`, lastSentAt: new Date().toISOString(), suppressedCount: 0 })
    .onConflictDoNothing()
    .run();
}

function numberDetail(details: unknown, key: string): number | null {
  if (!details || typeof details !== "object" || !(key in details)) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function eventDetails(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
