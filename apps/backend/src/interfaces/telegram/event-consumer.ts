import { asc, eq, inArray } from "drizzle-orm";
import type { Bot } from "grammy";
import { refreshPostControlCard } from "../../bot/progress.js";
import type { BackendDb } from "../../db/client.js";
import { alertDedup, drafts, postEvents } from "../../db/schema.js";
import { notifyFinalVideoFailure, refreshVideoControlCard, sendVideoReminder } from "./video-notifications.js";

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
];

/** Consumes durable domain events and renders Telegram-only side effects once. */
export async function consumeTelegramEvents(backendDb: BackendDb, bot: Bot | null, reminderMinutes: number): Promise<number> {
  if (!bot) return 0;
  const events = backendDb.db
    .select()
    .from(postEvents)
    .where(inArray(postEvents.eventType, TELEGRAM_EVENT_TYPES))
    .orderBy(asc(postEvents.createdAt), asc(postEvents.id))
    .limit(50)
    .all();
  let handled = 0;
  for (const event of events) {
    if (wasDelivered(backendDb, event.id)) continue;
    const details = event.detailsJson ?? {};
    const videoDraftId = numberDetail(details, "videoDraftId");
    const videoTargetId = numberDetail(details, "videoTargetId");
    if (event.eventType === "delivery.post.settled" || event.eventType.startsWith("publish.job.")) {
      const postId = numberDetail(details, "post_id") ?? postIdFromRef(event.postKey);
      const draft = postId == null ? null : backendDb.db.select({ id: drafts.id }).from(drafts).where(eq(drafts.postId, postId)).get();
      if (draft) await refreshPostControlCard(backendDb, bot, draft.id);
    } else if (event.eventType === "video.reminder.due" && videoDraftId != null)
      await sendVideoReminder(backendDb, bot, videoDraftId, videoTargetId, reminderMinutes);
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
