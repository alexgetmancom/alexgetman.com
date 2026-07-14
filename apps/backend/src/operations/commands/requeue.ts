import { and, desc, eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { postTargets, publications, publishJobs } from "../../db/schema.js";
import { jsonObject } from "../../json.js";
import { localizeTargetPayload } from "../../publishing/payload.js";
import { type PublicationRef, sourcePayload } from "../publication-ref.js";

/** Restores queued Delivery work from its durable publication source. */
export function requeuePublication(backendDb: BackendDb, ref: PublicationRef, target?: string): Record<string, unknown> {
  const source = sourcePayload(backendDb, ref);
  const whereRef = ref.postId != null ? eq(publishJobs.postId, ref.postId) : eq(publishJobs.postKey, ref.postKey);
  const rows = backendDb.db
    .select()
    .from(publishJobs)
    .where(target ? and(whereRef, eq(publishJobs.target, target)) : whereRef)
    .orderBy(desc(publishJobs.jobId))
    .all();
  const latest = new Map<string, typeof publishJobs.$inferSelect>();
  for (const row of rows) if (!latest.has(row.target)) latest.set(row.target, row);
  if (latest.size === 0 && target) {
    const fallback = backendDb.db.select().from(publishJobs).where(whereRef).orderBy(desc(publishJobs.updatedAt)).get();
    const payload = localizeTargetPayload(Object.keys(source).length > 0 ? source : jsonObject(fallback?.payloadJson), target);
    if (Object.keys(payload).length === 0) throw new Error("no publish jobs found");
    const now = new Date().toISOString();
    const inserted = backendDb.db
      .insert(publishJobs)
      .values({
        postId: ref.postId,
        postKey: ref.postKey,
        messageId: ref.messageId,
        target,
        status: "queued",
        attemptCount: 0,
        publishAt: now,
        nextAttemptAt: null,
        lockedBy: null,
        lockedAt: null,
        payloadJson: payload,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (inserted) latest.set(target, inserted);
  }
  if (latest.size === 0) throw new Error("no publish jobs found");
  const now = new Date().toISOString();
  const queued: string[] = [];
  backendDb.db.transaction((tx) => {
    for (const [targetId, row] of latest) {
      const existing = tx
        .select({ jobId: publishJobs.jobId })
        .from(publishJobs)
        .where(
          and(
            ref.postId != null ? eq(publishJobs.postId, ref.postId) : eq(publishJobs.postKey, ref.postKey),
            eq(publishJobs.target, targetId),
            eq(publishJobs.status, "queued"),
          ),
        )
        .get();
      if (!existing) {
        const payload = localizeTargetPayload(Object.keys(source).length > 0 ? source : jsonObject(row.payloadJson), targetId);
        tx.update(publishJobs)
          .set({
            status: "queued",
            attemptCount: 0,
            publishAt: now,
            nextAttemptAt: null,
            lockedBy: null,
            lockedAt: null,
            payloadJson: payload,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(publishJobs.jobId, row.jobId))
          .run();
      }
      tx.insert(postTargets)
        .values({
          postKey: row.postKey ?? ref.postKey,
          target: targetId,
          status: "queued",
          error: null,
          skipped: 0,
          updatedAt: now,
          rawJson: JSON.stringify({ requeued: true }),
        })
        .onConflictDoUpdate({
          target: [postTargets.postKey, postTargets.target],
          set: { status: "queued", error: null, skipped: 0, updatedAt: now, rawJson: JSON.stringify({ requeued: true }) },
        })
        .run();
      queued.push(targetId);
    }
    if (ref.postId != null)
      tx.update(publications).set({ status: "scheduled", updatedAt: now }).where(eq(publications.postId, ref.postId)).run();
  });
  return { ok: true, post_id: ref.postId, post_key: ref.postKey, message_id: ref.messageId, target: target ?? null, targets: queued };
}
