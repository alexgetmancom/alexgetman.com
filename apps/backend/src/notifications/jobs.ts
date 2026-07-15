import { and, asc, eq, lte } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { studioNotificationJobs } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";

type NotificationPreference = { remindersEnabled: boolean; reminderMinutes: number; completionEnabled: boolean };

export function scheduleReminder(
  backendDb: BackendDb,
  input: {
    adminId: number;
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
  backendDb.db
    .insert(studioNotificationJobs)
    .values({
      adminId: input.adminId,
      ref: input.ref,
      kind: input.kind,
      runAt,
      status: "queued",
      payloadJson: {
        title: input.title,
        targets: input.targets,
        publish_at: input.publishAt.toISOString(),
        minutes: input.preference.reminderMinutes,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [studioNotificationJobs.ref, studioNotificationJobs.kind],
      set: {
        runAt,
        status: "queued",
        payloadJson: {
          title: input.title,
          targets: input.targets,
          publish_at: input.publishAt.toISOString(),
          minutes: input.preference.reminderMinutes,
        },
        updatedAt: timestamp,
      },
    })
    .run();
}

export function cancelScheduledNotifications(backendDb: BackendDb, ref: string): void {
  backendDb.db
    .update(studioNotificationJobs)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(and(eq(studioNotificationJobs.ref, ref), eq(studioNotificationJobs.status, "queued")))
    .run();
}

/** Core worker: turns due notification jobs into durable Studio events. */
export function runNotificationCycle(backendDb: BackendDb, limit = 50): number {
  const now = new Date().toISOString();
  const jobs = backendDb.db
    .select()
    .from(studioNotificationJobs)
    .where(and(eq(studioNotificationJobs.status, "queued"), lte(studioNotificationJobs.runAt, now)))
    .orderBy(asc(studioNotificationJobs.runAt), asc(studioNotificationJobs.id))
    .limit(limit)
    .all();
  let delivered = 0;
  for (const job of jobs) {
    const claimed = backendDb.db
      .update(studioNotificationJobs)
      .set({ status: "delivered", updatedAt: now })
      .where(and(eq(studioNotificationJobs.id, job.id), eq(studioNotificationJobs.status, "queued")))
      .returning({ id: studioNotificationJobs.id })
      .get();
    if (!claimed) continue;
    const payload = job.payloadJson ?? {};
    recordDomainEvent(backendDb, {
      ref: job.ref,
      type: "studio.notification.reminder.due",
      severity: "info",
      message: `Publication reminder: ${String(payload.title ?? job.ref)}`,
      details: { admin_id: job.adminId, notification_job_id: job.id, kind: job.kind, ...payload },
    });
    delivered += 1;
  }
  return delivered;
}
