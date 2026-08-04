import { and, desc, eq, isNull } from "drizzle-orm";
import type { PostEventRecord, StudioNotificationStore } from "../../application/ports.js";
import { drafts, postEvents, posts, studioNotificationJobs, videoDrafts } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for the transport-neutral Studio notification inbox. */
export function createStudioNotificationStore(db: BackendDatabase): StudioNotificationStore {
  return {
    unread(limit: number): PostEventRecord[] {
      return db
        .select()
        .from(postEvents)
        .where(isNull(postEvents.ackedAt))
        .orderBy(desc(postEvents.createdAt), desc(postEvents.id))
        .limit(limit)
        .all();
    },

    get(id: number): PostEventRecord | null {
      return db.select().from(postEvents).where(eq(postEvents.id, id)).get() ?? null;
    },

    acknowledge(id: number, now: string): boolean {
      db.update(postEvents).set({ ackedAt: now }).where(eq(postEvents.id, id)).run();
      return true;
    },

    cancelQueuedReminders(actorId: number, now: string): number {
      return db
        .update(studioNotificationJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(studioNotificationJobs.actorId, actorId), eq(studioNotificationJobs.status, "queued")))
        .returning({ id: studioNotificationJobs.id })
        .all().length;
    },

    draftOwner(draftId: number): number | null {
      return db.select({ actorId: drafts.actorId }).from(drafts).where(eq(drafts.id, draftId)).get()?.actorId ?? null;
    },

    videoOwner(publicationId: number): number | null {
      return db.select({ actorId: videoDrafts.actorId }).from(videoDrafts).where(eq(videoDrafts.id, publicationId)).get()?.actorId ?? null;
    },

    postIdForKey(postKey: string): number | null {
      return db.select({ postId: posts.postId }).from(posts).where(eq(posts.postKey, postKey)).get()?.postId ?? null;
    },

    postOwner(postId: number): number | null {
      return db.select({ actorId: drafts.actorId }).from(drafts).where(eq(drafts.postId, postId)).get()?.actorId ?? null;
    },
  };
}
