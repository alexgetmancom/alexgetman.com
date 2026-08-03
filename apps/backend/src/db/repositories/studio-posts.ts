import { desc, eq, inArray, or } from "drizzle-orm";
import type { DraftEntityCandidate, DraftSource, PostEventRecord, StudioPostStore } from "../../application/ports.js";
import { draftEntityCandidates, draftSources, drafts, postEvents, publishJobs, siteJobs, studioNotificationSettings } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for Studio post-specific persistence operations. */
export function createStudioPostStore(db: BackendDatabase): StudioPostStore {
  return {
    sources(draftId: number): DraftSource[] {
      return db.select().from(draftSources).where(eq(draftSources.draftId, draftId)).orderBy(draftSources.sortOrder).all();
    },

    replaceSources(draftId: number, urls: string[], now: string): void {
      db.delete(draftSources).where(eq(draftSources.draftId, draftId)).run();
      if (urls.length === 0) return;
      db.insert(draftSources)
        .values(
          urls.map((url, sortOrder) => ({
            draftId,
            url,
            labelRu: sourceLabel(url),
            labelEn: sourceLabel(url),
            sortOrder,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .run();
    },

    replaceEntityCandidates(draftId: number, candidates: DraftEntityCandidate[], now: string): void {
      db.delete(draftEntityCandidates).where(eq(draftEntityCandidates.draftId, draftId)).run();
      if (candidates.length === 0) return;
      db.insert(draftEntityCandidates)
        .values(candidates.map((entity) => ({ ...entity, draftId, status: "suggested", createdAt: now, updatedAt: now })))
        .run();
    },

    acceptEntityCandidates(draftId: number, now: string): void {
      db.update(draftEntityCandidates).set({ status: "accepted", updatedAt: now }).where(eq(draftEntityCandidates.draftId, draftId)).run();
    },

    notificationSettings(actorIds: number[]) {
      return actorIds.length
        ? db
            .select({ actorId: studioNotificationSettings.actorId, remindersEnabled: studioNotificationSettings.remindersEnabled })
            .from(studioNotificationSettings)
            .where(inArray(studioNotificationSettings.actorId, actorIds))
            .all()
        : [];
    },

    history(draftId: number, postId: number | null, limit: number): PostEventRecord[] {
      const scope =
        postId == null
          ? eq(postEvents.postKey, `draft:${draftId}`)
          : or(eq(postEvents.postKey, `draft:${draftId}`), eq(postEvents.postKey, `post:${postId}`));
      return db.select().from(postEvents).where(scope).orderBy(desc(postEvents.createdAt), desc(postEvents.id)).limit(limit).all();
    },

    progress(draftId: number) {
      const draft = db
        .select({ id: drafts.id, actorId: drafts.actorId, postId: drafts.postId, targetsJson: drafts.targetsJson })
        .from(drafts)
        .where(eq(drafts.id, draftId))
        .get();
      if (!draft) return null;
      return {
        draft,
        publishJobs:
          draft.postId == null
            ? []
            : db
                .select({ target: publishJobs.target, status: publishJobs.status, lastError: publishJobs.lastError })
                .from(publishJobs)
                .where(eq(publishJobs.postId, draft.postId))
                .all(),
        siteJobs:
          draft.postId == null
            ? []
            : db
                .select({ reason: siteJobs.reason, status: siteJobs.status, lastError: siteJobs.lastError })
                .from(siteJobs)
                .where(eq(siteJobs.postId, draft.postId))
                .all(),
      };
    },
  };
}

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
