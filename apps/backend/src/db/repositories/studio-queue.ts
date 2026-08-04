import { and, desc, eq, inArray } from "drizzle-orm";
import type { StudioQueuePost, StudioQueueStore, StudioQueueVideo, StudioQueueVideoTarget } from "../../application/ports.js";
import { channelConnections, draftStoryCards, drafts, publishJobs, siteJobs, videoDrafts, videoTargets } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for the transport-neutral Studio queue projection. */
export function createStudioQueueStore(db: BackendDatabase): StudioQueueStore {
  return {
    posts(actorIds: number[], limit: number): StudioQueuePost[] {
      return (
        db
          .select({
            id: drafts.id,
            actorId: drafts.actorId,
            status: drafts.status,
            textRu: drafts.textRu,
            targetsJson: drafts.targetsJson,
            updatedAt: drafts.updatedAt,
            scheduledAt: drafts.scheduledAt,
            scheduledEnAt: drafts.scheduledEnAt,
            postId: drafts.postId,
          })
          .from(drafts)
          .where(inArray(drafts.actorId, actorIds))
          // Apply the cap after recency ordering so archive history cannot hide new work.
          .orderBy(desc(drafts.updatedAt), desc(drafts.id))
          .limit(limit)
          .all()
      );
    },

    videos(actorIds: number[], limit: number): StudioQueueVideo[] {
      return (
        db
          .select({
            id: videoDrafts.id,
            actorId: videoDrafts.actorId,
            status: videoDrafts.status,
            label: videoDrafts.label,
            updatedAt: videoDrafts.updatedAt,
          })
          .from(videoDrafts)
          .where(inArray(videoDrafts.actorId, actorIds))
          // Apply the cap after recency ordering so archive history cannot hide new work.
          .orderBy(desc(videoDrafts.updatedAt), desc(videoDrafts.id))
          .limit(limit)
          .all()
      );
    },

    failedPostIds(postIds: number[]): number[] {
      if (postIds.length === 0) return [];
      const failed = db
        .select({ postId: publishJobs.postId })
        .from(publishJobs)
        .where(and(inArray(publishJobs.postId, postIds), inArray(publishJobs.status, ["failed", "verification_required"])))
        .all();
      const failedSite = db
        .select({ postId: siteJobs.postId })
        .from(siteJobs)
        .where(and(inArray(siteJobs.postId, postIds), eq(siteJobs.status, "failed")))
        .all();
      return [...new Set([...failed, ...failedSite].flatMap((row) => (row.postId == null ? [] : [row.postId])))];
    },

    failedStoryCardDraftIds(draftIds: number[]): number[] {
      if (draftIds.length === 0) return [];
      return [
        ...new Set(
          db
            .select({ draftId: draftStoryCards.draftId })
            .from(draftStoryCards)
            .where(and(inArray(draftStoryCards.draftId, draftIds), eq(draftStoryCards.status, "failed")))
            .all()
            .map((row) => row.draftId),
        ),
      ];
    },

    videoTargets(publicationIds: number[]): StudioQueueVideoTarget[] {
      if (publicationIds.length === 0) return [];
      return db
        .select({
          publicationId: videoTargets.videoDraftId,
          status: videoTargets.status,
          scheduledAt: videoTargets.scheduledAt,
        })
        .from(videoTargets)
        .where(inArray(videoTargets.videoDraftId, publicationIds))
        .all();
    },

    effectivePostTargets(targets: Record<string, boolean>): Record<string, boolean> {
      const registered = new Set(
        db
          .select({ targetId: channelConnections.targetId })
          .from(channelConnections)
          .where(eq(channelConnections.enabled, 1))
          .all()
          .map((row) => row.targetId)
          .filter((target): target is string => Boolean(target)),
      );
      if (registered.size === 0) return { ...targets };
      return Object.fromEntries(Object.entries(targets).map(([target, enabled]) => [target, enabled && registered.has(target)]));
    },
  };
}
