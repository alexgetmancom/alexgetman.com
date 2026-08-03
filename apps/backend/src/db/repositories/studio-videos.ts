import { asc, desc, eq, inArray } from "drizzle-orm";
import type { PostEventRecord, StudioVideoStore } from "../../application/ports.js";
import { postEvents, videoDrafts, videoJobs, videoTargets } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite read adapter for Studio video drafts, targets, jobs, and history. */
export function createStudioVideoStore(db: BackendDatabase): StudioVideoStore {
  return {
    get(videoDraftId) {
      return db.select().from(videoDrafts).where(eq(videoDrafts.id, videoDraftId)).get() ?? null;
    },

    list(actorIds, limit) {
      return db
        .select()
        .from(videoDrafts)
        .where(inArray(videoDrafts.actorId, actorIds))
        .orderBy(desc(videoDrafts.updatedAt))
        .limit(limit)
        .all();
    },

    targets(videoDraftId) {
      return db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, videoDraftId)).orderBy(asc(videoTargets.id)).all();
    },

    jobs(videoDraftId) {
      return db.select().from(videoJobs).where(eq(videoJobs.videoDraftId, videoDraftId)).orderBy(desc(videoJobs.id)).all();
    },

    history(postKey, limit): PostEventRecord[] {
      return db
        .select()
        .from(postEvents)
        .where(eq(postEvents.postKey, postKey))
        .orderBy(desc(postEvents.createdAt), desc(postEvents.id))
        .limit(limit)
        .all();
    },
  };
}
