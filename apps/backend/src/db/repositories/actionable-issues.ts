import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { ActionableIssue, ActionableIssueStore } from "../../application/ports.js";
import { publicationRef } from "../../application/publication-ref.js";
import { draftStoryCards, drafts, publicationTargets, siteJobs, videoDrafts, videoTargets } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** Statuses a target ends up in when nobody else will move it: either the
 * publication failed, or it reached the audience and we cannot prove it. */
const ACTIONABLE_TARGET_STATUSES = ["failed", "verification_required"];

/** A video still being written is not a publication yet; a failed target under
 * it is the author's draft, not the operator's queue. */
const INERT_VIDEO_DRAFT_STATUSES = ["draft", "editing", "cancelled"];

/** Site cards and Story cards are rendered, not published: their only terminal
 * failure is the job's, and there is no ambiguous middle to verify. */
const SITE_TARGETS = ["site_ru", "site_en"];

/** The single answer to "what needs a human right now".
 *
 * Studio filters it by actor and Operations shows all of it, but neither owns
 * the definition: three copies of it disagreed, and the one behind the Command
 * Center's red dot was the narrowest, so a publication could sit unverified
 * with nobody watching. */
export function createActionableIssueStore(db: BackendDatabase): ActionableIssueStore {
  return {
    list(actorIds?: number[]): ActionableIssue[] {
      const byActor = actorIds?.length ? actorIds : null;

      const posts = db
        .select({
          draftId: drafts.id,
          actorId: drafts.actorId,
          postId: drafts.postId,
          target: publicationTargets.target,
          status: publicationTargets.status,
          updatedAt: publicationTargets.updatedAt,
        })
        .from(publicationTargets)
        .innerJoin(drafts, eq(publicationTargets.publicationKey, sql`'post:' || ${drafts.postId}`))
        .where(
          and(
            isNotNull(drafts.postId),
            notInArray(publicationTargets.target, SITE_TARGETS),
            inArray(publicationTargets.status, ACTIONABLE_TARGET_STATUSES),
            ...(byActor ? [inArray(drafts.actorId, byActor)] : []),
          ),
        )
        .all();

      const site = db
        .select({
          draftId: drafts.id,
          actorId: drafts.actorId,
          postId: drafts.postId,
          target: siteJobs.reason,
          updatedAt: siteJobs.updatedAt,
        })
        .from(siteJobs)
        .innerJoin(drafts, eq(siteJobs.publicationKey, sql`'post:' || ${drafts.postId}`))
        .where(and(isNotNull(drafts.postId), eq(siteJobs.status, "failed"), ...(byActor ? [inArray(drafts.actorId, byActor)] : [])))
        .all();

      const story = db
        .select({
          draftId: draftStoryCards.draftId,
          actorId: drafts.actorId,
          postId: drafts.postId,
          target: draftStoryCards.locale,
          updatedAt: draftStoryCards.updatedAt,
        })
        .from(draftStoryCards)
        .innerJoin(drafts, eq(draftStoryCards.draftId, drafts.id))
        .where(and(eq(draftStoryCards.status, "failed"), ...(byActor ? [inArray(drafts.actorId, byActor)] : [])))
        .all();

      const video = db
        .select({
          draftId: videoDrafts.id,
          actorId: videoDrafts.actorId,
          target: videoTargets.target,
          status: videoTargets.status,
          updatedAt: videoTargets.updatedAt,
        })
        .from(videoTargets)
        .innerJoin(videoDrafts, eq(videoTargets.videoDraftId, videoDrafts.id))
        .where(
          and(
            inArray(videoTargets.status, ACTIONABLE_TARGET_STATUSES),
            notInArray(videoDrafts.status, INERT_VIDEO_DRAFT_STATUSES),
            ...(byActor ? [inArray(videoDrafts.actorId, byActor)] : []),
          ),
        )
        .all();

      return [
        ...posts.map((row) => ({
          kind: "post" as const,
          publicationKey: publicationRef("post", row.postId as number),
          draftId: row.draftId,
          actorId: row.actorId,
          target: row.target,
          status: row.status === "verification_required" ? ("verification_required" as const) : ("failed" as const),
          updatedAt: row.updatedAt,
        })),
        ...site.map((row) => ({
          kind: "site" as const,
          publicationKey: publicationRef("post", row.postId as number),
          draftId: row.draftId,
          actorId: row.actorId,
          target: row.target,
          status: "failed" as const,
          updatedAt: row.updatedAt,
        })),
        ...story.map((row) => ({
          kind: "story" as const,
          publicationKey: row.postId == null ? null : publicationRef("post", row.postId),
          draftId: row.draftId,
          actorId: row.actorId,
          target: row.target,
          status: "failed" as const,
          updatedAt: row.updatedAt,
        })),
        ...video.map((row) => ({
          kind: "video" as const,
          publicationKey: publicationRef("video", row.draftId),
          draftId: row.draftId,
          actorId: row.actorId,
          target: row.target,
          status: row.status === "verification_required" ? ("verification_required" as const) : ("failed" as const),
          updatedAt: row.updatedAt,
        })),
      ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
  };
}
