import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { parsePublicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { recordEvent } from "../db/repositories/events.js";
import { studioNotificationJobs } from "../db/schema.js";

type NotificationPreference = { remindersEnabled: boolean; reminderMinutes: number; completionEnabled: boolean };

export function scheduleReminder(
  backendDb: BackendDb,
  input: {
    actorId: number;
    ref: string;
    kind: string;
    publishAt: Date;
    title: string;
    targets: string[];
    preference: NotificationPreference;
  },
): void {
  if (!input.preference.remindersEnabled) return;
  const now = new Date();
  const runAt = new Date(Math.max(now.getTime(), input.publishAt.getTime() - input.preference.reminderMinutes * 60_000)).toISOString();
  const timestamp = now.toISOString();
  const payloadJson = {
    title: input.title,
    targets: input.targets,
    publish_at: input.publishAt.toISOString(),
    minutes: input.preference.reminderMinutes,
  };
  unsafeDb(backendDb)
    .db.insert(studioNotificationJobs)
    .values({
      actorId: input.actorId,
      ref: input.ref,
      kind: input.kind,
      runAt,
      status: "queued",
      payloadJson,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [studioNotificationJobs.ref, studioNotificationJobs.kind],
      set: { runAt, status: "queued", payloadJson, updatedAt: timestamp },
    })
    .run();
}

export function cancelScheduledNotifications(backendDb: BackendDb, ref: string): void {
  const parsed = parsePublicationRef(ref);
  const refs = parsed ? [ref, `${parsed.kind}:${parsed.id}`] : [ref];
  unsafeDb(backendDb)
    .db.update(studioNotificationJobs)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(and(inArray(studioNotificationJobs.ref, refs), eq(studioNotificationJobs.status, "queued")))
    .run();
}

/** Core worker: turns due notification jobs into durable Studio events. */
export function runNotificationCycle(backendDb: BackendDb, limit = 50): number {
  const now = new Date().toISOString();
  const jobs = unsafeDb(backendDb)
    .db.select()
    .from(studioNotificationJobs)
    .where(and(eq(studioNotificationJobs.status, "queued"), lte(studioNotificationJobs.runAt, now)))
    .orderBy(asc(studioNotificationJobs.runAt), asc(studioNotificationJobs.id))
    .limit(limit)
    .all();
  let delivered = 0;
  for (const job of jobs) {
    // Claim and emit as one unit. Marking the job delivered first meant a
    // failing recordDomainEvent silently swallowed the reminder: the job was
    // terminal, and nothing left to retry.
    const emitted = unsafeDb(backendDb).db.transaction((tx) => {
      const claimed = tx
        .update(studioNotificationJobs)
        .set({ status: "delivered", updatedAt: now })
        .where(and(eq(studioNotificationJobs.id, job.id), eq(studioNotificationJobs.status, "queued")))
        .returning({ id: studioNotificationJobs.id })
        .get();
      if (!claimed) return false;
      const payload = job.payloadJson ?? {};
      recordEvent(unsafeDb(backendDb).db, backendDb.clock, {
        ref: job.ref,
        type: "studio.notification.reminder.due",
        severity: "info",
        message: `Publication reminder: ${String(payload.title ?? job.ref)}`,
        details: { actor_id: job.actorId, notification_job_id: job.id, kind: job.kind, ...payload },
      });
      return true;
    });
    if (emitted) delivered += 1;
  }
  return delivered;
}
