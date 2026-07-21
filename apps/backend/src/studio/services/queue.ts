import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { drafts, publishJobs, siteJobs, videoDrafts, videoTargets } from "../../db/schema.js";
import { parseTargets } from "../../publishing/targets.js";

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

/** Read-only work inbox for every Studio interface. It deliberately returns
 * entity references, not Telegram callbacks or display markup. */
export function queueService(backendDb: BackendDb) {
  return {
    snapshot(actorId: number): StudioQueueSnapshot {
      const upcoming: StudioQueueItem[] = [];
      const draftItems: StudioQueueItem[] = [];
      const attention: StudioAttentionItem[] = [];
      const postDrafts = backendDb.db.select().from(drafts).where(eq(drafts.adminId, actorId)).all();
      const videos = backendDb.db.select().from(videoDrafts).where(eq(videoDrafts.adminId, actorId)).all();

      for (const draft of postDrafts) {
        const label = shorten(draft.textRu.split("\n")[0]?.trim() || `Post #${draft.id}`);
        if (draft.status === "scheduled") {
          const scheduledAt = earliestDate(draft.scheduledAt, draft.scheduledEnAt);
          if (scheduledAt)
            upcoming.push({ id: draft.id, label, time: scheduledAt, kind: "post", targets: enabledPostTargets(draft.targetsJson) });
        }
        if (draft.status === "needs_review")
          draftItems.push({ id: draft.id, label, time: new Date(draft.updatedAt), kind: "post", targets: 0 });
        if (draft.postId != null) {
          const failed = backendDb.db
            .select({ jobId: publishJobs.jobId })
            .from(publishJobs)
            .where(and(eq(publishJobs.postId, draft.postId), eq(publishJobs.status, "failed")))
            .limit(1)
            .get();
          const failedSite = backendDb.db
            .select({ jobId: siteJobs.jobId })
            .from(siteJobs)
            .where(and(eq(siteJobs.postId, draft.postId), eq(siteJobs.status, "failed")))
            .limit(1)
            .get();
          if (failed || failedSite) attention.push({ id: draft.id, label, kind: "post" });
        }
      }

      for (const video of videos) {
        const targets = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, video.id)).all();
        const scheduled = targets.filter((target) => target.status === "scheduled" && target.scheduledAt != null);
        const label = shorten(video.label.trim() || `Video #${video.id}`);
        if (video.status === "scheduled" && scheduled.length) {
          const time = new Date(Math.min(...scheduled.map((target) => new Date(target.scheduledAt ?? 0).getTime())));
          upcoming.push({ id: video.id, label, time, kind: "video", targets: scheduled.length });
        }
        if (video.status === "draft" || video.status === "editing")
          draftItems.push({ id: video.id, label, time: new Date(video.updatedAt), kind: "video", targets: 0 });
        if (targets.some((target) => target.status === "failed")) attention.push({ id: video.id, label, kind: "video" });
      }

      upcoming.sort((left, right) => left.time.getTime() - right.time.getTime());
      draftItems.sort((left, right) => right.time.getTime() - left.time.getTime());
      return { upcoming, drafts: draftItems, attention };
    },
  };
}

function enabledPostTargets(value: string): number {
  return Object.values(parseTargets(value)).filter(Boolean).length;
}

function earliestDate(...values: Array<string | null>): Date | null {
  const dates = values.filter((value): value is string => value != null).map((value) => new Date(value));
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
}

function shorten(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 38).trim();
}
