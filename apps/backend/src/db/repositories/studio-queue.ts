import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type {
  StudioQueuePost,
  StudioQueuePublished,
  StudioQueueStore,
  StudioQueueVideo,
  StudioQueueVideoTarget,
} from "../../application/ports.js";
import { draftStoryCards, drafts, posts, publicationTargets, publishJobs, siteJobs, videoDrafts, videoTargets } from "../schema.js";
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

    latestPublished(actorIds: number[]): StudioQueuePublished | null {
      const post = db
        .select({ id: drafts.id, label: drafts.textRu, publishedAt: publicationTargets.publishedAt })
        .from(drafts)
        .innerJoin(posts, eq(posts.postId, drafts.postId))
        .innerJoin(publicationTargets, eq(publicationTargets.publicationKey, posts.publicationKey))
        .where(
          and(inArray(drafts.actorId, actorIds), eq(publicationTargets.status, "published"), isNotNull(publicationTargets.publishedAt)),
        )
        .orderBy(desc(publicationTargets.publishedAt))
        .limit(1)
        .get();
      const video = db
        .select({ id: videoDrafts.id, label: videoDrafts.label, publishedAt: videoTargets.publishedAt })
        .from(videoDrafts)
        .innerJoin(videoTargets, eq(videoTargets.videoDraftId, videoDrafts.id))
        .where(and(inArray(videoDrafts.actorId, actorIds), eq(videoTargets.status, "published"), isNotNull(videoTargets.publishedAt)))
        .orderBy(desc(videoTargets.publishedAt))
        .limit(1)
        .get();
      if (!post?.publishedAt && !video?.publishedAt) return null;
      if (post?.publishedAt && (!video?.publishedAt || post.publishedAt >= video.publishedAt)) {
        return { id: post.id, label: post.label, kind: "post", publishedAt: post.publishedAt };
      }
      if (!video?.publishedAt) return null;
      return { id: video.id, label: video.label, kind: "video", publishedAt: video.publishedAt };
    },

    failedPostIds(postIds: number[]): number[] {
      if (postIds.length === 0) return [];
      const failed = db
        .select({ postId: publishJobs.publicationId })
        .from(publishJobs)
        .where(and(inArray(publishJobs.publicationId, postIds), inArray(publishJobs.status, ["failed", "verification_required"])))
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
  };
}
