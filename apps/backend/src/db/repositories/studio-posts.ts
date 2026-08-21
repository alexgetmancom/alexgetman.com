import { desc, eq, or } from "drizzle-orm";
import type { DraftEntityCandidate, FailedPublicationTarget, PostEventRecord, StudioPostStore } from "../../application/ports.js";
import { publicationRef } from "../../application/publication-ref.js";
import { isSiteTarget } from "../../botTargets.js";
import { publicationSourceFromDb } from "../../publishing/source-store.js";
import { draftEntityCandidates, drafts, publicationEvents, publishJobs, siteJobs } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for Studio post-specific persistence operations. */
export function createStudioPostStore(db: BackendDatabase): StudioPostStore {
  return {
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

    history(draftId: number, postId: number | null, limit: number): PostEventRecord[] {
      const scope =
        postId == null
          ? eq(publicationEvents.publicationKey, publicationRef("draft", draftId))
          : or(
              eq(publicationEvents.publicationKey, publicationRef("draft", draftId)),
              eq(publicationEvents.publicationKey, publicationRef("post", postId)),
            );
      return db
        .select()
        .from(publicationEvents)
        .where(scope)
        .orderBy(desc(publicationEvents.createdAt), desc(publicationEvents.id))
        .limit(limit)
        .all();
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
                .where(eq(publishJobs.publicationKey, publicationRef("post", draft.postId)))
                .all(),
        siteJobs:
          draft.postId == null
            ? []
            : db
                .select({ reason: siteJobs.reason, status: siteJobs.status, lastError: siteJobs.lastError })
                .from(siteJobs)
                .where(eq(siteJobs.publicationKey, publicationRef("post", draft.postId)))
                .all(),
      };
    },

    publicationSource(postId: number): Record<string, unknown> {
      return publicationSourceFromDb(db, postId);
    },

    failedPublicationTargets(postId: number): FailedPublicationTarget[] {
      const publicationKey = publicationRef("post", postId);
      const social = db
        .select({ target: publishJobs.target, status: publishJobs.status, error: publishJobs.lastError, jobId: publishJobs.jobId })
        .from(publishJobs)
        .where(eq(publishJobs.publicationKey, publicationKey))
        .orderBy(desc(publishJobs.jobId))
        .all();
      const latestSocial = new Map<string, (typeof social)[number]>();
      for (const row of social) if (!latestSocial.has(row.target)) latestSocial.set(row.target, row);

      const site = db
        .select({ reason: siteJobs.reason, status: siteJobs.status, error: siteJobs.lastError, jobId: siteJobs.jobId })
        .from(siteJobs)
        .where(eq(siteJobs.publicationKey, publicationKey))
        .orderBy(desc(siteJobs.jobId))
        .all();
      const latestSite = new Map<string, (typeof site)[number]>();
      for (const row of site) {
        if (isSiteTarget(row.reason) && !latestSite.has(row.reason)) latestSite.set(row.reason, row);
      }

      return [...latestSocial.entries(), ...latestSite.entries()].flatMap(([target, row]) => {
        if (row.status !== "failed" && row.status !== "verification_required") return [];
        return [{ target, status: row.status, error: row.error }];
      });
    },
  };
}
