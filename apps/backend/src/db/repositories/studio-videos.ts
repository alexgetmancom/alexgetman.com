import { asc, desc, eq, inArray } from "drizzle-orm";
import type { PostEventRecord, StudioVideoStore } from "../../application/ports.js";
import { parsePublicationRef } from "../../application/publication-ref.js";
import { publicationEvents, videoDrafts, videoJobs, videoTargets } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite read adapter for Studio video drafts, targets, jobs, and history. */
export function createStudioVideoStore(db: BackendDatabase): StudioVideoStore {
  return {
    get(publicationId) {
      return db.select().from(videoDrafts).where(eq(videoDrafts.id, publicationId)).get() ?? null;
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

    targets(publicationId) {
      return db
        .select()
        .from(videoTargets)
        .where(eq(videoTargets.videoDraftId, publicationId))
        .orderBy(asc(videoTargets.id))
        .all()
        .map(({ videoDraftId, ...target }) => ({ ...target, publicationId: videoDraftId }));
    },

    jobs(publicationId) {
      return db
        .select()
        .from(videoJobs)
        .where(eq(videoJobs.videoDraftId, publicationId))
        .orderBy(desc(videoJobs.id))
        .all()
        .map(({ videoDraftId, ...job }) => ({ ...job, publicationId: videoDraftId }));
    },

    history(publicationKey, limit): PostEventRecord[] {
      const parsed = parsePublicationRef(publicationKey);
      const refs = parsed ? [publicationKey, `${parsed.kind}:${parsed.id}`] : [publicationKey];
      return db
        .select()
        .from(publicationEvents)
        .where(inArray(publicationEvents.publicationKey, refs))
        .orderBy(desc(publicationEvents.createdAt), desc(publicationEvents.id))
        .limit(limit)
        .all();
    },
  };
}
