import { effectivePostTargets } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { truncateUnicode } from "../../foundation/text.js";
import { parseJsonValue } from "../../json.js";
import { trackUsageSync } from "../../observability/usage.js";
import { hasUnscheduledLocale } from "../../publishing/state.js";
import { parseTargets } from "../../publishing/targets.js";
import { accessibleStudioActorIds } from "../access.js";

export type StudioQueueItem = {
  id: number;
  label: string;
  time: Date;
  kind: "post" | "video";
  targets: number;
};

export type StudioQueueAttentionItem = {
  id: number;
  label: string;
  kind: "post" | "video";
  time: Date;
};

export type StudioQueueSnapshot = {
  upcoming: StudioQueueItem[];
  drafts: StudioQueueItem[];
  attention: StudioQueueAttentionItem[];
};

export type StudioQueueActivity = Pick<StudioQueueItem, "id" | "label" | "time" | "kind">;

const MAX_QUEUE_ROWS = 100;

/** Read-only work inbox for every Studio interface. It deliberately returns
 * entity references, not Telegram callbacks or display markup. */
export function queueService(backendDb: BackendDb, config: BackendConfig) {
  return {
    headline(actorId: number): { upcoming: StudioQueueActivity | null; published: StudioQueueActivity | null } {
      const actorIds = accessibleStudioActorIds(config, actorId);
      const upcoming = this.snapshot(actorId).upcoming[0] ?? null;
      const published = backendDb.studioQueue.latestPublished(actorIds);
      return {
        upcoming,
        published: published
          ? {
              id: published.id,
              label: shorten(published.kind === "post" ? (published.label.split("\n")[0]?.trim() ?? published.label) : published.label),
              time: new Date(published.publishedAt),
              kind: published.kind,
            }
          : null,
      };
    },
    snapshot(actorId: number, limit = MAX_QUEUE_ROWS): StudioQueueSnapshot {
      return trackUsageSync(backendDb, "studio.queue.read", () => {
        const upcoming: StudioQueueItem[] = [];
        const draftItems: StudioQueueItem[] = [];
        const attention: StudioQueueAttentionItem[] = [];
        const actorIds = accessibleStudioActorIds(config, actorId);
        const rowLimit = Math.max(1, Math.min(limit, MAX_QUEUE_ROWS));
        const postDrafts = backendDb.studioQueue.posts(actorIds, rowLimit);
        const videos = backendDb.studioQueue.videos(actorIds, rowLimit);

        const postIds = postDrafts.flatMap((draft) => (draft.postId == null ? [] : [draft.postId]));
        const failedPostIds = new Set(backendDb.studioQueue.failedPostIds(postIds));
        const failedStoryCardDraftIds = new Set(backendDb.studioQueue.failedStoryCardDraftIds(postDrafts.map((draft) => draft.id)));
        const nowMs = backendDb.clock.now().getTime();

        for (const draft of postDrafts) {
          const label = shorten(draft.textRu.split("\n")[0]?.trim() || `Post #${draft.id}`);
          const scheduleGap =
            draft.status === "scheduled" && draftScheduleGap(backendDb, draft.targetsJson, draft.scheduledAt, draft.scheduledEnAt);
          if (draft.status === "scheduled" && !scheduleGap) {
            const scheduledAt = earliestFutureDate(nowMs, draft.scheduledAt, draft.scheduledEnAt);
            if (scheduledAt)
              upcoming.push({
                id: draft.id,
                label,
                time: scheduledAt,
                kind: "post",
                targets: enabledPostTargets(backendDb, draft.targetsJson),
              });
          }
          if (scheduleGap)
            draftItems.push({ id: draft.id, label: `⏳ ${label}`, time: new Date(draft.updatedAt), kind: "post", targets: 0 });
          if (draft.status === "needs_review")
            draftItems.push({ id: draft.id, label, time: new Date(draft.updatedAt), kind: "post", targets: 0 });
          if ((draft.postId != null && failedPostIds.has(draft.postId)) || failedStoryCardDraftIds.has(draft.id))
            attention.push({ id: draft.id, label, kind: "post", time: new Date(draft.updatedAt) });
        }

        // One query for every draft's targets rather than one per draft: this
        // snapshot backs a screen the operator opens constantly.
        const targetsByDraft = new Map<number, ReturnType<BackendDb["studioQueue"]["videoTargets"]>[number][]>();
        if (videos.length) {
          const rows = backendDb.studioQueue.videoTargets(videos.map((video) => video.id));
          for (const row of rows) targetsByDraft.set(row.publicationId, [...(targetsByDraft.get(row.publicationId) ?? []), row]);
        }

        for (const video of videos) {
          const targets = targetsByDraft.get(video.id) ?? [];
          const scheduled = targets.filter(
            (target): target is (typeof targets)[number] & { scheduledAt: string } =>
              target.status === "scheduled" && target.scheduledAt != null && new Date(target.scheduledAt).getTime() > nowMs,
          );
          const label = shorten(video.label.trim() || `Video #${video.id}`);
          if (video.status === "scheduled" && scheduled.length) {
            const time = new Date(Math.min(...scheduled.map((target) => new Date(target.scheduledAt).getTime())));
            upcoming.push({ id: video.id, label, time, kind: "video", targets: scheduled.length });
          }
          if (video.status === "draft" || video.status === "editing")
            draftItems.push({ id: video.id, label, time: new Date(video.updatedAt), kind: "video", targets: 0 });
          if (targets.some((target) => target.status === "failed" || target.status === "verification_required"))
            attention.push({ id: video.id, label, kind: "video", time: new Date(video.updatedAt) });
        }

        upcoming.sort((left, right) => left.time.getTime() - right.time.getTime());
        draftItems.sort((left, right) => right.time.getTime() - left.time.getTime());
        attention.sort((left, right) => right.time.getTime() - left.time.getTime());
        return { upcoming, drafts: draftItems, attention };
      });
    },
  };
}

function enabledPostTargets(backendDb: BackendDb, value: string): number {
  return Object.values(effectivePostTargets(backendDb, parseTargets(value))).filter(Boolean).length;
}

function earliestFutureDate(nowMs: number, ...values: Array<string | null>): Date | null {
  const dates = values
    .filter((value): value is string => value != null)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()) && date.getTime() > nowMs);
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null;
}

function draftScheduleGap(backendDb: BackendDb, targetsJson: string, scheduledAt: string | null, scheduledEnAt: string | null): boolean {
  const parsed = parseJsonValue(targetsJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const targets = effectivePostTargets(
    backendDb,
    Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([target, enabled]) => [target, Boolean(enabled)])),
  );
  return hasUnscheduledLocale(targets, scheduledAt, scheduledEnAt);
}

function shorten(value: string): string {
  return truncateUnicode(value.replace(/\s+/g, " "), 38).trim();
}
