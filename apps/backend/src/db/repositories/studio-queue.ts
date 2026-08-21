import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type {
  StudioQueuePost,
  StudioQueuePublished,
  StudioQueueStore,
  StudioQueueVideo,
  StudioQueueVideoTarget,
} from "../../application/ports.js";
import { drafts, postLocales, publicationTargets, videoDrafts, videoTargets } from "../schema.js";
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
            textRu: postLocales.sourceText,
            targetsJson: drafts.targetsJson,
            updatedAt: drafts.updatedAt,
            scheduledAt: drafts.scheduledAt,
            scheduledEnAt: drafts.scheduledEnAt,
            postId: drafts.postId,
          })
          .from(drafts)
          .innerJoin(postLocales, and(eq(postLocales.draftId, drafts.id), eq(postLocales.locale, "ru")))
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
        .select({ id: drafts.id, label: postLocales.sourceText, publishedAt: publicationTargets.publishedAt })
        .from(drafts)
        .innerJoin(postLocales, and(eq(postLocales.draftId, drafts.id), eq(postLocales.locale, "ru")))
        .innerJoin(publicationTargets, eq(publicationTargets.publicationKey, sql`'post:' || ${drafts.postId}`))
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
