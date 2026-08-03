import type { DraftPatch, DraftRecord } from "../../application/ports.js";
import { PRESETS, presetName, TARGETS, targetLocale } from "../../botTargets.js";
import { effectivePostTargets, registeredPostTargetIds } from "../../channels/registry.js";
import { listStudioMediaAssets, mediaItemsFromAssets, requireStudioMediaAssets } from "../../content/assets.js";
import { createDraftFromMessage } from "../../content/index.js";
import type { DraftMessage } from "../../content/message.js";
import type { BackendDb } from "../../db/client.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { cancelDraft, cancelRemainingPostJobs } from "../../publishing/draft-lifecycle.js";
import { publishDraftToQueue } from "../../publishing/publication-workflow.js";
import { parseManualSchedule, scheduleClockToday } from "../../publishing/schedule.js";
import { parseTargets } from "../../publishing/targets.js";
import { type StoryPublishMode, setStoryPublishMode } from "../../story-cards/store.js";
import { accessibleStudioActorIds, studioActorIds } from "../access.js";
import { draftMedia, requireOwnedDraft } from "./post-access.js";
import { postQueryService } from "./post-queries.js";

type ScheduleInput = { ruAt: Date | null; enAt: Date | null };
type ScheduleScope = "ru" | "en" | "both";
type EditInput = {
  locale: "ru" | "en";
  text: string;
  entities: unknown[];
  media: Record<string, unknown>[];
  replaceMediaOnly?: boolean;
  /** Caller has already recognized an explicit "clear media" command in its own transport. */
  clearMedia?: boolean;
};
type DraftEntityCandidate = { kind: "company" | "model" | "person" | "topic"; slug: string; titleRu: string; titleEn: string | null };

/** Commands for post drafts. These are deliberately transport-free and become the
 * single entry point for Telegram, Web Studio and later MCP mutations. */
export function postService(backendDb: BackendDb, config: BackendConfig) {
  const queries = postQueryService(backendDb, config);
  return {
    create(actorId: number, message: DraftMessage): number {
      return createDraftFromMessage(backendDb, actorId, message);
    },
    ...queries,
    setStoryPublishMode(actorId: number, draftId: number, mode: StoryPublishMode): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      setStoryPublishMode(backendDb, draftId, mode);
    },
    replaceSources(actorId: number, draftId: number, urls: string[]): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      const uniqueUrls = [...new Set(urls)];
      backendDb.studioPosts.replaceSources(draftId, uniqueUrls, backendDb.clock.now().toISOString());
    },
    replaceEntityCandidates(actorId: number, draftId: number, candidates: DraftEntityCandidate[]): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      backendDb.studioPosts.replaceEntityCandidates(draftId, candidates, backendDb.clock.now().toISOString());
    },
    acceptEntityCandidates(actorId: number, draftId: number): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      backendDb.studioPosts.acceptEntityCandidates(draftId, backendDb.clock.now().toISOString());
    },
    /** Waives the 500-character Threads rule for this draft: the overflow becomes
     * a reply chain. Deliberately has no "off" command — editing the text resets
     * it, and a draft nobody waived is the normal state. */
    approveThreadsChain(actorId: number, draftId: number): void {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      backendDb.drafts.update(draftId, { threadsChainApproved: 1, updatedAt: backendDb.clock.now().toISOString() });
      recordDomainEvent(backendDb.events, {
        ref: `draft:${draftId}`,
        type: "content.draft.threads-chain-approved",
        severity: "info",
        message: `Draft #${draftId} waived the Threads single-post rule`,
        details: {},
      });
    },
    publish(actorId: number, draftId: number): number {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      return publishDraftToQueue(backendDb, draftId);
    },
    schedule(actorId: number, draftId: number, input: ScheduleInput): number {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ...input });
      const scheduled = requireOwnedDraft(backendDb, config, actorId, draftId);
      const preference = workspaceNotificationPreference(backendDb, config);
      const title = draft.text_ru.trim().split("\n")[0]?.slice(0, 100) || `Post #${postId}`;
      if (scheduled.scheduled_at)
        scheduleReminder(backendDb, {
          actorId: actorId,
          ref: `post:${postId}`,
          kind: "post.ru",
          publishAt: new Date(scheduled.scheduled_at),
          title,
          targets: localeTargets(backendDb, draft.targets_json, "ru"),
          preference,
        });
      if (scheduled.scheduled_en_at)
        scheduleReminder(backendDb, {
          actorId: actorId,
          ref: `post:${postId}`,
          kind: "post.en",
          publishAt: new Date(scheduled.scheduled_en_at),
          title,
          targets: localeTargets(backendDb, draft.targets_json, "en"),
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
    manualSchedule(actorId: number, draftId: number, scope: ScheduleScope, value: string): ScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, config, actorId, draftId), scope, parseManualSchedule(value));
    },
    scheduleAt(actorId: number, draftId: number, scope: ScheduleScope, value: Date): ScheduleInput {
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
    toggleTarget(actorId: number, draftId: number, target: string): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      if (!TARGETS.some(({ id }) => id === target)) throw new StudioError("err.unknown-target");
      const registered = registeredPostTargetIds(backendDb);
      if (registered.size && !registered.has(target)) throw new StudioError("err.unknown-target");
      const targets = parseTargets(draft.targets_json);
      targets[target] = !targets[target];
      saveTargets(backendDb, draftId, targets);
    },
    cycleMode(actorId: number, draftId: number): keyof typeof PRESETS {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const targets = parseTargets(draft.targets_json);
      const current = presetName(targets);
      const next = current === "full" ? "ru" : current === "ru" ? "en" : current === "en" ? "tg" : "full";
      const preset = effectivePostTargets(backendDb, PRESETS[next] ?? {});
      if (!preset) throw new StudioError("err.post-mode");
      saveTargets(backendDb, draftId, preset);
      return next;
    },
    edit(actorId: number, draftId: number, input: EditInput): void {
      editDraftContent(backendDb, config, actorId, draftId, input);
    },
    mediaAssets(actorId: number, limit = 50) {
      return listStudioMediaAssets(backendDb, actorId, limit, accessibleStudioActorIds(config, actorId));
    },
    attachMediaAssets(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[], replace = false): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const assets = mediaItemsFromAssets(
        requireStudioMediaAssets(backendDb, actorId, assetIds, accessibleStudioActorIds(config, actorId)),
      );
      const key = locale === "ru" ? "mediaRuJson" : "mediaEnJson";
      const current = replace ? [] : draftMedia(draft, locale);
      backendDb.drafts.update(draftId, { [key]: JSON.stringify([...current, ...assets]), updatedAt: backendDb.clock.now().toISOString() });
      backendDb.storyCards.queue(draftId);
      recordDomainEvent(backendDb.events, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_attached",
        severity: "info",
        message: `Draft #${draftId} media attached`,
        details: { locale, asset_ids: assetIds, replace },
      });
    },
    removeMedia(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[]): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const current = draftMedia(draft, locale);
      const removed = new Set(assetIds);
      const media = current.filter((item) => !removed.has(Number(item.asset_id)));
      backendDb.drafts.update(draftId, {
        [locale === "ru" ? "mediaRuJson" : "mediaEnJson"]: JSON.stringify(media),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      backendDb.storyCards.queue(draftId);
      recordDomainEvent(backendDb.events, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_removed",
        severity: "info",
        message: `Draft #${draftId} media removed`,
        details: { locale, asset_ids: assetIds },
      });
    },
  };
}

function workspaceNotificationPreference(backendDb: BackendDb, config: BackendConfig) {
  const actorIds = studioActorIds(config);
  const rows = backendDb.studioPosts.notificationSettings(actorIds);
  const byActor = new Map(rows.map((row) => [row.actorId, row]));
  return {
    remindersEnabled: actorIds.some((actorId) => byActor.get(actorId)?.remindersEnabled !== 0),
    reminderMinutes: config.VIDEO_REMINDER_MINUTES,
    completionEnabled: true,
  };
}

function localeTargets(backendDb: BackendDb, json: string, locale: "ru" | "en"): string[] {
  return Object.entries(effectivePostTargets(backendDb, parseTargets(json)))
    .filter(([target, enabled]) => enabled && targetLocale(target) === locale)
    .map(([target]) => target);
}

function editDraftContent(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, input: EditInput): void {
  requireOwnedDraft(backendDb, config, actorId, draftId);
  const clearMedia = Boolean(input.clearMedia);
  const update: DraftPatch = { updatedAt: backendDb.clock.now().toISOString() };
  const ru = input.locale === "ru";
  if (clearMedia) update[ru ? "mediaRuJson" : "mediaEnJson"] = null;
  else {
    if (input.media.length) update[ru ? "mediaRuJson" : "mediaEnJson"] = JSON.stringify(input.media);
    if (!input.replaceMediaOnly && input.text) {
      update[ru ? "textRu" : "textEnApproved"] = input.text;
      update[ru ? "textRuEntitiesJson" : "textEnEntitiesJson"] = JSON.stringify(input.entities);
      // The waiver was given for a specific text the author had read. New text is
      // a new decision, so the 500-character rule applies again until waived anew.
      update.threadsChainApproved = 0;
    }
  }
  if (Object.keys(update).length === 1) throw new StudioError("err.post-no-edit");
  backendDb.drafts.update(draftId, update);
  backendDb.storyCards.queue(draftId);
  recordDomainEvent(backendDb.events, {
    ref: `draft:${draftId}`,
    type: "content.draft.edited",
    severity: "info",
    message: `Draft #${draftId} content updated`,
    details: { locale: input.locale, media_changed: input.media.length > 0 || clearMedia, text_changed: !input.replaceMediaOnly },
  });
}

function hasLocaleTarget(targets: Record<string, boolean>, locale: "ru" | "en"): boolean {
  return Object.entries(targets).some(([target, enabled]) => enabled && targetLocale(target) === locale);
}

function scheduleAt(draft: DraftRecord, scope: ScheduleScope, value: Date): ScheduleInput {
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

function saveTargets(backendDb: BackendDb, draftId: number, targets: Record<string, boolean>): void {
  backendDb.drafts.update(draftId, { targetsJson: JSON.stringify(targets), updatedAt: backendDb.clock.now().toISOString() });
}
