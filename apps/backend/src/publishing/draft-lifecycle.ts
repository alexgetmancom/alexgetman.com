import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import {
  drafts,
  postControlCards,
  postLocales,
  posts,
  publicationPlans,
  publicationSources,
  publications,
  publishJobs,
  siteJobs,
} from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import { rebalanceScheduledDrafts } from "./schedule.js";

export function scheduledDrafts(backendDb: BackendDb): Array<{ id: number; scheduledAt: string | null; scheduledEnAt: string | null }> {
  return backendDb.db
    .select({ id: drafts.id, scheduledAt: drafts.scheduledAt, scheduledEnAt: drafts.scheduledEnAt })
    .from(drafts)
    .where(eq(drafts.status, "scheduled"))
    .orderBy(asc(sql`coalesce(${drafts.scheduledAt}, ${drafts.scheduledEnAt})`), asc(drafts.id))
    .all();
}

export function cancelDraft(backendDb: BackendDb, draftId: number): void {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    const publication = tx.select({ postId: publications.postId }).from(publications).where(eq(publications.draftId, draftId)).get();
    const postId = publication?.postId;
    tx.update(drafts)
      .set({ status: "cancelled", scheduledAt: null, scheduledEnAt: null, updatedAt: now })
      .where(eq(drafts.id, draftId))
      .run();
    if (!postId) return;
    tx.update(publications).set({ status: "cancelled", updatedAt: now }).where(eq(publications.postId, postId)).run();
    const finalCount =
      tx
        .select({ count: count() })
        .from(publishJobs)
        .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["publishing", "published", "skipped"])))
        .get()?.count ?? 0;
    if (finalCount > 0) {
      tx.update(publishJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["queued", "failed"])))
        .run();
      tx.update(siteJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(siteJobs.postId, postId), inArray(siteJobs.status, ["queued", "failed"])))
        .run();
      return;
    }
    tx.delete(publishJobs).where(eq(publishJobs.postId, postId)).run();
    tx.delete(siteJobs).where(eq(siteJobs.postId, postId)).run();
    tx.delete(publicationPlans).where(eq(publicationPlans.postId, postId)).run();
    tx.delete(publicationSources).where(eq(publicationSources.postId, postId)).run();
    tx.delete(postLocales).where(eq(postLocales.postId, postId)).run();
    tx.delete(posts).where(eq(posts.postId, postId)).run();
    tx.delete(publications).where(eq(publications.postId, postId)).run();
    tx.update(drafts).set({ postId: null, updatedAt: now }).where(eq(drafts.id, draftId)).run();
  });
  rebalanceScheduledDrafts(backendDb);
  recordDomainEvent(backendDb, {
    ref: `draft:${draftId}`,
    type: "publishing.draft.cancelled",
    severity: "info",
    message: `Publication for draft #${draftId} cancelled`,
  });
}

export function setDraftControlCard(backendDb: BackendDb, draftId: number, chatId: number, messageId: number): void {
  backendDb.db
    .insert(postControlCards)
    .values({ draftId, chatId, messageId, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: postControlCards.draftId, set: { chatId, messageId, updatedAt: new Date().toISOString() } })
    .run();
}

/** Cancels only jobs that have not reached a final external state. */
export function cancelRemainingPostJobs(backendDb: BackendDb, draftId: number): void {
  const draft = backendDb.db.select({ postId: drafts.postId }).from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft?.postId) return;
  const now = new Date().toISOString();
  backendDb.db
    .update(publishJobs)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(publishJobs.postId, draft.postId), inArray(publishJobs.status, ["queued", "failed"])))
    .run();
  recordDomainEvent(backendDb, {
    ref: `draft:${draftId}`,
    type: "publishing.remaining.cancelled",
    severity: "warn",
    message: `Remaining publication jobs for draft #${draftId} cancelled`,
  });
  backendDb.db
    .update(siteJobs)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(siteJobs.postId, draft.postId), inArray(siteJobs.status, ["queued", "failed"])))
    .run();
}
