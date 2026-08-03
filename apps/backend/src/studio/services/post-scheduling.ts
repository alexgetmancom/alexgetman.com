import type { DraftRecord } from "../../application/ports.js";
import { targetLocale } from "../../botTargets.js";
import { effectivePostTargets } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { cancelDraft, cancelRemainingPostJobs } from "../../publishing/draft-lifecycle.js";
import { publishDraftToQueue } from "../../publishing/publication-workflow.js";
import { assertFutureSchedule, assertValidScheduleDate, parseManualSchedule, scheduleClockToday } from "../../publishing/schedule.js";
import { parseTargets } from "../../publishing/targets.js";
import { readyStoryCardMedia } from "../../story-cards/store.js";
import { requireOwnedDraft } from "./post-access.js";
import { settingsService } from "./settings.js";

export type PostScheduleInput = { ruAt: Date | null; enAt: Date | null; allowPast?: boolean };
export type PostScheduleScope = "ru" | "en" | "both";

/** Replans a scheduled text-only post after both regenerated Story cards are
 * ready. The draft keeps its previous all/site_only choice while cards render. */
export function replanScheduledPostAfterStoryCards(backendDb: BackendDb, config: BackendConfig, draftId: number): boolean {
  const draft = backendDb.drafts.get(draftId);
  if (draft?.status !== "scheduled" || (draft.story_publish_mode !== "all" && draft.story_publish_mode !== "site_only")) return false;
  if (!readyStoryCardMedia(backendDb, draftId)) return false;
  postSchedulingService(backendDb, config).schedule(draft.actor_id, draftId, {
    ruAt: dateOrNull(draft.scheduled_at),
    enAt: dateOrNull(draft.scheduled_en_at),
    allowPast: true,
  });
  return true;
}

/** Scheduling and lifecycle commands kept behind the public post facade. */
export function postSchedulingService(backendDb: BackendDb, config: BackendConfig) {
  return {
    schedule(actorId: number, draftId: number, input: PostScheduleInput): number {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const now = new Date();
      for (const value of [input.ruAt, input.enAt]) {
        if (!value) continue;
        if (input.allowPast) assertValidScheduleDate(value);
        else assertFutureSchedule(value, now);
      }
      const postId = publishDraftToQueue(backendDb, draftId, {
        mode: "scheduled",
        ruAt: input.ruAt,
        enAt: input.enAt,
      });
      const scheduled = requireOwnedDraft(backendDb, config, actorId, draftId);
      const preference = settingsService(backendDb).notifications(actorId);
      const title = draft.text_ru.trim().split("\n")[0]?.slice(0, 100) || `Post #${postId}`;
      cancelScheduledNotifications(backendDb, `post:${postId}`);
      const ruTargets = localeTargets(backendDb, draft.targets_json, "ru");
      const enTargets = localeTargets(backendDb, draft.targets_json, "en");
      if (scheduled.scheduled_at && ruTargets.length)
        scheduleReminder(backendDb, {
          actorId,
          ref: `post:${postId}`,
          kind: "post.ru",
          publishAt: new Date(scheduled.scheduled_at),
          title,
          targets: ruTargets,
          preference,
        });
      if (scheduled.scheduled_en_at && enTargets.length)
        scheduleReminder(backendDb, {
          actorId,
          ref: `post:${postId}`,
          kind: "post.en",
          publishAt: new Date(scheduled.scheduled_en_at),
          title,
          targets: enTargets,
          preference,
        });
      return postId;
    },

    hasLocaleTargets(actorId: number, draftId: number, locale: "ru" | "en"): boolean {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return hasLocaleTarget(effectivePostTargets(backendDb, parseTargets(draft.targets_json)), locale);
    },

    /** Resolves a slot-button clock (`HH:MM` MSK) to its next occurrence. */
    slotTime(clock: string): Date {
      return scheduleClockToday(clock);
    },

    manualSchedule(actorId: number, draftId: number, scope: PostScheduleScope, value: string): PostScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, config, actorId, draftId), scope, parseManualSchedule(value));
    },

    scheduleAt(actorId: number, draftId: number, scope: PostScheduleScope, value: Date): PostScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, config, actorId, draftId), scope, value);
    },

    cancel(actorId: number, draftId: number): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      cancelDraft(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, `post:${draft.post_id}`);
    },

    cancelRemaining(actorId: number, draftId: number): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      cancelRemainingPostJobs(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, `post:${draft.post_id}`);
    },
  };
}

function localeTargets(backendDb: BackendDb, json: string, locale: "ru" | "en"): string[] {
  return Object.entries(effectivePostTargets(backendDb, parseTargets(json)))
    .filter(([target, enabled]) => enabled && targetLocale(target) === locale)
    .map(([target]) => target);
}

function hasLocaleTarget(targets: Record<string, boolean>, locale: "ru" | "en"): boolean {
  return Object.entries(targets).some(([target, enabled]) => enabled && targetLocale(target) === locale);
}

function scheduleAt(draft: DraftRecord, scope: PostScheduleScope, value: Date): PostScheduleInput {
  return {
    ruAt: scope === "en" ? dateOrNull(draft.scheduled_at) : value,
    enAt: scope === "ru" ? dateOrNull(draft.scheduled_en_at) : value,
  };
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
