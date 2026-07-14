import { and, eq, isNull } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { drafts, postEvents, posts, videoDrafts } from "../../db/schema.js";
import { type DomainEventInput, recordDomainEvent } from "../../domain/events.js";

/** Durable Studio inbox backed by the existing operations event journal. */
export function notificationService(backendDb: BackendDb) {
  return {
    record(input: DomainEventInput): boolean {
      return recordDomainEvent(backendDb, input);
    },
    inbox(actorId: number, limit = 50) {
      const events = backendDb.db
        .select()
        .from(postEvents)
        .where(isNull(postEvents.ackedAt))
        .orderBy(postEvents.createdAt)
        .limit(limit)
        .all();
      return events.filter((event) => isVisibleTo(backendDb, event.postKey, actorId));
    },
    acknowledge(actorId: number, id: number): boolean {
      const event = backendDb.db.select().from(postEvents).where(eq(postEvents.id, id)).get();
      if (!event || !isVisibleTo(backendDb, event.postKey, actorId)) return false;
      backendDb.db.update(postEvents).set({ ackedAt: new Date().toISOString() }).where(eq(postEvents.id, id)).run();
      return true;
    },
  };
}

/** Operational events without a Studio entity remain shared; draft/video events are private to their owner. */
function isVisibleTo(backendDb: BackendDb, ref: string | null, actorId: number): boolean {
  if (!ref) return true;
  if (ref.startsWith("draft:")) {
    const id = Number(ref.slice("draft:".length));
    return (
      Number.isSafeInteger(id) &&
      backendDb.db
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.adminId, actorId)))
        .get() != null
    );
  }
  if (ref.startsWith("video:")) {
    const id = Number(ref.slice("video:".length));
    if (!Number.isSafeInteger(id)) return false;
    return (
      backendDb.db
        .select({ id: videoDrafts.id })
        .from(videoDrafts)
        .where(and(eq(videoDrafts.id, id), eq(videoDrafts.adminId, actorId)))
        .get() != null
    );
  }
  const postId = ref.startsWith("post:")
    ? Number(ref.slice("post:".length))
    : backendDb.db.select({ postId: posts.postId }).from(posts).where(eq(posts.postKey, ref)).get()?.postId;
  if (postId == null || !Number.isSafeInteger(postId)) return true;
  return (
    backendDb.db
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.postId, postId), eq(drafts.adminId, actorId)))
      .get() != null
  );
}
