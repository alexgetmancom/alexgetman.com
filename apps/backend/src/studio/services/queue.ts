import { and, eq, inArray } from "drizzle-orm";
import { effectivePostTargets } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import { drafts, publishJobs, siteJobs, videoDrafts, videoTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { parseTargets } from "../../publishing/targets.js";
import { accessibleStudioActorIds } from "../access.js";

export type StudioQueueItem = {
  id: number;
  label: string;
  time: Date;
  kind: "post" | "video";
  targets: number;
};

type StudioAttentionItem = {
  id: number;
  label: string;
  kind: "post" | "video";
};

export type StudioQueueSnapshot = {
  upcoming: StudioQueueItem[];
  drafts: StudioQueueItem[];
  attention: StudioAttentionItem[];
};

const MAX_QUEUE_ROWS = 100;

/** Read-only work inbox for every Studio interface. It deliberately returns
 * entity references, not Telegram callbacks or display markup. */
export function queueService(backendDb: BackendDb, config: BackendConfig) {
  return {
    snapshot(actorId: number, limit = MAX_QUEUE_ROWS): StudioQueueSnapshot {
      const upcoming: StudioQueueItem[] = [];
      const draftItems: StudioQueueItem[] = [];
      const attention: StudioAttentionItem[] = [];
      const actorIds = accessibleStudioActorIds(config, actorId);
      const rowLimit = Math.max(1, Math.min(limit, MAX_QUEUE_ROWS));
      const postDrafts = backendDb.db.select().from(drafts).where(inArray(drafts.actorId, actorIds)).limit(rowLimit).all();
      const videos = backendDb.db.select().from(videoDrafts).where(inArray(videoDrafts.actorId, actorIds)).limit(rowLimit).all();

      const postIds = postDrafts.flatMap((draft) => (draft.postId == null ? [] : [draft.postId]));
      const failedPostIds = new Set<number>();
      if (postIds.length) {
        const failedPublishJobs = backendDb.db
          .select({ postId: publishJobs.postId })
          .from(publishJobs)
          .where(and(inArray(publishJobs.postId, postIds), inArray(publishJobs.status, ["failed", "verification_required"])))
          .all();
        const failedSiteJobs = backendDb.db
          .select({ postId: siteJobs.postId })
          .from(siteJobs)
          .where(and(inArray(siteJobs.postId, postIds), eq(siteJobs.status, "failed")))
          .all();
        for (const row of [...failedPublishJobs, ...failedSiteJobs]) if (row.postId != null) failedPostIds.add(row.postId);
      }

      for (const draft of postDrafts) {
        const label = shorten(draft.textRu.split("\n")[0]?.trim() || `Post #${draft.id}`);
        if (draft.status === "scheduled") {
          const scheduledAt = earliestDate(draft.scheduledAt, draft.scheduledEnAt);
          if (scheduledAt)
            upcoming.push({
              id: draft.id,
              label,
              time: scheduledAt,
              kind: "post",
              targets: enabledPostTargets(backendDb, draft.targetsJson),
            });
        }
        if (draft.status === "needs_review")
          draftItems.push({ id: draft.id, label, time: new Date(draft.updatedAt), kind: "post", targets: 0 });
        if (draft.postId != null && failedPostIds.has(draft.postId)) attention.push({ id: draft.id, label, kind: "post" });
      }

      // One query for every draft's targets rather than one per draft: this
      // snapshot backs a screen the operator opens constantly.
      const targetsByDraft = new Map<number, (typeof videoTargets.$inferSelect)[]>();
      if (videos.length) {
        const rows = backendDb.db
          .select()
          .from(videoTargets)
          .where(
            inArray(
              videoTargets.videoDraftId,
              videos.map((video) => video.id),
            ),
          )
          .all();
        for (const row of rows) targetsByDraft.set(row.videoDraftId, [...(targetsByDraft.get(row.videoDraftId) ?? []), row]);
      }

      for (const video of videos) {
        const targets = targetsByDraft.get(video.id) ?? [];
        const scheduled = targets.filter(
          (target): target is (typeof targets)[number] & { scheduledAt: string } =>
            target.status === "scheduled" && target.scheduledAt != null,
        );
        const label = shorten(video.label.trim() || `Video #${video.id}`);
        if (video.status === "scheduled" && scheduled.length) {
          const time = new Date(Math.min(...scheduled.map((target) => new Date(target.scheduledAt).getTime())));
          upcoming.push({ id: video.id, label, time, kind: "video", targets: scheduled.length });
        }
        if (video.status === "draft" || video.status === "editing")
          draftItems.push({ id: video.id, label, time: new Date(video.updatedAt), kind: "video", targets: 0 });
        if (targets.some((target) => target.status === "failed" || target.status === "verification_required"))
          attention.push({ id: video.id, label, kind: "video" });
      }

      upcoming.sort((left, right) => left.time.getTime() - right.time.getTime());
      draftItems.sort((left, right) => right.time.getTime() - left.time.getTime());
      return { upcoming, drafts: draftItems, attention };
    },
  };
}

function enabledPostTargets(backendDb: BackendDb, value: string): number {
  return Object.values(effectivePostTargets(backendDb, parseTargets(value))).filter(Boolean).length;
}

function earliestDate(...values: Array<string | null>): Date | null {
  const dates = values.filter((value): value is string => value != null).map((value) => new Date(value));
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
}

function shorten(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 38).trim();
}
