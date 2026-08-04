import type { DraftPatch, DraftRecord } from "../../application/ports.js";
import { isStoryTarget, PRESETS, presetName, TARGETS, targetLocale } from "../../botTargets.js";
import { effectivePostTargets, registeredPostTargetIds } from "../../channels/registry.js";
import { listStudioMediaAssets, mediaItemsFromAssets, requireStudioMediaAssets } from "../../content/assets.js";
import { draftLocaleContent } from "../../content/draft-content.js";
import { createDraftFromMessage } from "../../content/index.js";
import type { DraftMessage } from "../../content/message.js";
import type { BackendDb } from "../../db/client.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../notifications/jobs.js";
import { cancelDraft, cancelRemainingPostJobs } from "../../publishing/draft-lifecycle.js";
import { mediaPolicyForTarget } from "../../publishing/media-policy.js";
import { publicationPreflight } from "../../publishing/preflight.js";
import { publishDraftToQueue } from "../../publishing/publication-workflow.js";
import { assertFutureSchedule, assertValidScheduleDate, parseManualSchedule, scheduleClockToday } from "../../publishing/schedule.js";
import { parseTargets } from "../../publishing/targets.js";
import { readyStoryCardMedia, type StoryPublishMode, setStoryPublishMode, storyCardsForDraft } from "../../story-cards/store.js";
import { accessibleStudioActorIds } from "../access.js";
import { postDeliveryProjections } from "../projections.js";
import { draftMedia, requireMutableDraft, requireOwnedDraft, requirePostEditAllowed } from "./post-access.js";
import { postProgressState } from "./post-progress.js";
import { settingsService } from "./settings.js";

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

export type PostScheduleInput = { ruAt: Date | null; enAt: Date | null; allowPast?: boolean; immediateLocale?: "ru" | "en" };
export type PostScheduleScope = "ru" | "en" | "both";

/** Replans a scheduled text-only post after regenerated Story cards are ready. */
export function replanScheduledPostAfterStoryCards(backendDb: BackendDb, config: BackendConfig, draftId: number): boolean {
  const draft = backendDb.drafts.get(draftId);
  if (draft?.status !== "scheduled" || (draft.story_publish_mode !== "all" && draft.story_publish_mode !== "site_only")) return false;
  if (!readyStoryCardMedia(backendDb, draftId)) return false;
  schedulePost(backendDb, config, draft.actor_id, draftId, {
    ruAt: scheduledDate(draft.scheduled_at),
    enAt: scheduledDate(draft.scheduled_en_at),
    allowPast: true,
  });
  return true;
}

/** Replans ordinary delivery after Story-card rendering gives up. */
export function replanScheduledPostAfterStoryCardFailure(backendDb: BackendDb, config: BackendConfig, draftId: number): boolean {
  const draft = backendDb.drafts.get(draftId);
  if (draft?.status !== "scheduled" || (draft.story_publish_mode !== "all" && draft.story_publish_mode !== "site_only")) return false;
  const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
  if (!Object.entries(targets).some(([target, enabled]) => enabled && isStoryTarget(target))) return false;
  if (!storyCardsForDraft(backendDb, draftId).some((card) => card.status === "failed")) return false;
  schedulePost(backendDb, config, draft.actor_id, draftId, {
    ruAt: scheduledDate(draft.scheduled_at),
    enAt: scheduledDate(draft.scheduled_en_at),
    allowPast: true,
  });
  recordDomainEvent(backendDb.events, {
    ref: `draft:${draftId}`,
    type: "studio.notification.story-cards.failed",
    severity: "error",
    message: `Story cards failed for draft #${draftId}; Story delivery was skipped`,
    details: { draft_id: draftId },
    cooldownSeconds: 3600,
  });
  return true;
}

/** Replans a scheduled post after a durable content or target mutation. */
export function replanScheduledPostAfterMutation(backendDb: BackendDb, config: BackendConfig, draftId: number): boolean {
  const draft = backendDb.drafts.get(draftId);
  if (draft?.status !== "scheduled") return false;
  const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
  const hasMedia = draftMedia(draft, "ru").length > 0 || draftMedia(draft, "en").length > 0;
  const hasStoryTarget = Object.entries(targets).some(([target, enabled]) => enabled && isStoryTarget(target));
  const waitsForStoryCards = draft.story_publish_mode === "all" || draft.story_publish_mode === "site_only";
  const hasFailedStoryCard = storyCardsForDraft(backendDb, draftId).some((card) => card.status === "failed");
  if (waitsForStoryCards && hasStoryTarget && !hasMedia && !hasFailedStoryCard && !readyStoryCardMedia(backendDb, draftId)) return false;
  schedulePost(backendDb, config, draft.actor_id, draftId, {
    ruAt: scheduledDate(draft.scheduled_at),
    enAt: scheduledDate(draft.scheduled_en_at),
    allowPast: true,
  });
  return true;
}

/** Commands for post drafts. These are deliberately transport-free and become the
 * single entry point for Telegram, Web Studio and later MCP mutations. */
export function postService(backendDb: BackendDb, config: BackendConfig) {
  return {
    create(actorId: number, message: DraftMessage): number {
      return createDraftFromMessage(backendDb, actorId, message);
    },
    get(actorId: number, draftId: number) {
      return requireOwnedDraft(backendDb, config, actorId, draftId);
    },
    list(actorId: number, limit = 50) {
      return backendDb.drafts.list(accessibleStudioActorIds(config, actorId), limit);
    },
    validate(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return publicationPreflight({
        ...draft,
        targets_json: JSON.stringify(effectivePostTargets(backendDb, parseTargets(draft.targets_json))),
      });
    },
    preview(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const ruContent = draftLocaleContent(draft, "ru");
      const enContent = draftLocaleContent(draft, "en");
      const storyCards = storyCardsForDraft(backendDb, draftId);
      const storyCardsReady = ["ru", "en"].every((locale) =>
        storyCards.some((card) => card.locale === locale && card.status === "ready" && card.localPath),
      );
      const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
      return {
        id: draft.id,
        status: draft.status,
        locales: [
          { locale: "ru" as const, ...ruContent },
          { locale: "en" as const, ...enContent },
        ],
        targets,
        sources: backendDb.studioPosts.sources(draftId),
        mediaPolicy: Object.entries(targets)
          .filter(([, enabled]) => enabled)
          .map(([target]) => mediaPolicyForTarget(target, targetLocale(target) === "ru" ? ruContent.media : enContent.media)),
        delivery: postDeliveryProjections(draft, storyCardsReady),
        storyCards,
      };
    },
    progress(actorId: number, draftId: number) {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      return postProgressState(backendDb, draftId);
    },
    status(actorId: number, draftId: number) {
      return postProgressState(backendDb, requireOwnedDraft(backendDb, config, actorId, draftId).id);
    },
    history(actorId: number, draftId: number, limit = 50) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return backendDb.studioPosts.history(draft.id, draft.post_id, limit);
    },
    mediaAssets(actorId: number, limit = 50) {
      return listStudioMediaAssets(backendDb, actorId, limit, accessibleStudioActorIds(config, actorId));
    },
    attachMediaAssets(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[], replace = false): void {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      const assets = mediaItemsFromAssets(
        requireStudioMediaAssets(backendDb, actorId, assetIds, accessibleStudioActorIds(config, actorId)),
      );
      const key = locale === "ru" ? "mediaRuJson" : "mediaEnJson";
      const current = replace ? [] : draftMedia(draft, locale);
      backendDb.drafts.update(draftId, {
        [key]: JSON.stringify([...current, ...assets]),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      backendDb.storyCards.queue(draftId);
      replanScheduledPostAfterMutation(backendDb, config, draftId);
      recordDomainEvent(backendDb.events, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_attached",
        severity: "info",
        message: `Draft #${draftId} media attached`,
        details: { locale, asset_ids: assetIds, replace },
      });
    },
    removeMedia(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[]): void {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      const current = draftMedia(draft, locale);
      const removed = new Set(assetIds);
      const media = current.filter((item) => !removed.has(Number(item.asset_id)));
      backendDb.drafts.update(draftId, {
        [locale === "ru" ? "mediaRuJson" : "mediaEnJson"]: JSON.stringify(media),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      backendDb.storyCards.queue(draftId);
      replanScheduledPostAfterMutation(backendDb, config, draftId);
      recordDomainEvent(backendDb.events, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_removed",
        severity: "info",
        message: `Draft #${draftId} media removed`,
        details: { locale, asset_ids: assetIds },
      });
    },
    schedule(actorId: number, draftId: number, input: PostScheduleInput): number {
      return schedulePost(backendDb, config, actorId, draftId, input);
    },
    hasLocaleTargets(actorId: number, draftId: number, locale: "ru" | "en"): boolean {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return hasLocaleTarget(effectivePostTargets(backendDb, parseTargets(draft.targets_json)), locale);
    },
    slotTime(clock: string): Date {
      return scheduleClockToday(clock, config.TIMEZONE, backendDb.clock.now());
    },
    manualSchedule(actorId: number, draftId: number, scope: PostScheduleScope, value: string): PostScheduleInput {
      return scheduleAt(
        requireOwnedDraft(backendDb, config, actorId, draftId),
        scope,
        parseManualSchedule(value, config.TIMEZONE, backendDb.clock.now()),
      );
    },
    scheduleAt(actorId: number, draftId: number, scope: PostScheduleScope, value: Date): PostScheduleInput {
      return scheduleAt(requireOwnedDraft(backendDb, config, actorId, draftId), scope, value);
    },
    cancel(actorId: number, draftId: number): void {
      const draft = requireMutableDraft(backendDb, config, actorId, draftId);
      cancelDraft(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, `post:${draft.post_id}`);
    },
    cancelRemaining(actorId: number, draftId: number): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      cancelRemainingPostJobs(backendDb, draftId);
      if (draft.post_id != null) cancelScheduledNotifications(backendDb, `post:${draft.post_id}`);
    },
    setStoryPublishMode(actorId: number, draftId: number, mode: StoryPublishMode): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      setStoryPublishMode(backendDb, draftId, mode);
      replanScheduledPostAfterMutation(backendDb, config, draftId);
    },
    replaceSources(actorId: number, draftId: number, urls: string[]): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      const uniqueUrls = [...new Set(urls)];
      backendDb.studioPosts.replaceSources(draftId, uniqueUrls, backendDb.clock.now().toISOString());
      replanScheduledPostAfterMutation(backendDb, config, draftId);
    },
    replaceEntityCandidates(actorId: number, draftId: number, candidates: DraftEntityCandidate[]): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      backendDb.studioPosts.replaceEntityCandidates(draftId, candidates, backendDb.clock.now().toISOString());
      replanScheduledPostAfterMutation(backendDb, config, draftId);
    },
    acceptEntityCandidates(actorId: number, draftId: number): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      backendDb.studioPosts.acceptEntityCandidates(draftId, backendDb.clock.now().toISOString());
      replanScheduledPostAfterMutation(backendDb, config, draftId);
    },
    /** Waives the 500-character Threads rule for this draft: the overflow becomes
     * a reply chain. Deliberately has no "off" command — editing the text resets
     * it, and a draft nobody waived is the normal state. */
    approveThreadsChain(actorId: number, draftId: number): void {
      requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      backendDb.drafts.update(draftId, { threadsChainApproved: 1, updatedAt: backendDb.clock.now().toISOString() });
      replanScheduledPostAfterMutation(backendDb, config, draftId);
      recordDomainEvent(backendDb.events, {
        ref: `draft:${draftId}`,
        type: "content.draft.threads-chain-approved",
        severity: "info",
        message: `Draft #${draftId} waived the Threads single-post rule`,
        details: {},
      });
    },
    publish(actorId: number, draftId: number): number {
      requireMutableDraft(backendDb, config, actorId, draftId);
      return publishDraftToQueue(backendDb, draftId);
    },
    retryFailed(actorId: number, draftId: number, target?: string) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      if (draft.post_id == null) throw new StudioError("err.retry-only-failed");
      const failed = backendDb.studioPosts.failedPublicationTargets(draft.post_id);
      const selected = target ? failed.filter((item) => item.target === target) : failed;
      if (selected.length === 0) throw new StudioError("err.retry-only-failed");
      const results = backendDb.studioPosts.retryPublicationTargets(
        draft.post_id,
        selected.map((item) => item.target),
      );
      const requeued = results.filter((item) => item.outcome === "requeued").length;
      const alreadyQueued = results.filter((item) => item.outcome === "already_queued").length;
      if (requeued === 0 && alreadyQueued === 0) throw new StudioError("err.retry-only-failed");
      return { results, requeued, alreadyQueued };
    },
    toggleTarget(actorId: number, draftId: number, target: string): void {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      if (!TARGETS.some(({ id }) => id === target)) throw new StudioError("err.unknown-target");
      const registered = registeredPostTargetIds(backendDb);
      if (registered.size && !registered.has(target)) throw new StudioError("err.unknown-target");
      const targets = parseTargets(draft.targets_json);
      targets[target] = !targets[target];
      saveTargetsAndReschedule(backendDb, config, actorId, draftId, draft, targets);
    },
    removeTarget(actorId: number, draftId: number, target: string): void {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      if (!TARGETS.some(({ id }) => id === target)) throw new StudioError("err.unknown-target");
      const registered = registeredPostTargetIds(backendDb);
      if (registered.size && !registered.has(target)) throw new StudioError("err.unknown-target");
      const targets = parseTargets(draft.targets_json);
      if (!targets[target]) return;
      targets[target] = false;
      saveTargetsAndReschedule(backendDb, config, actorId, draftId, draft, targets);
    },
    cycleMode(actorId: number, draftId: number): keyof typeof PRESETS {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      const targets = parseTargets(draft.targets_json);
      const current = presetName(targets);
      const next = current === "full" ? "ru" : current === "ru" ? "en" : current === "en" ? "tg" : "full";
      const preset = effectivePostTargets(backendDb, PRESETS[next] ?? {});
      if (!preset) throw new StudioError("err.post-mode");
      saveTargetsAndReschedule(backendDb, config, actorId, draftId, draft, preset);
      return next;
    },
    edit(actorId: number, draftId: number, input: EditInput): void {
      const draft = editDraftContent(backendDb, config, actorId, draftId, input);
      const updated = backendDb.drafts.get(draftId) ?? draft;
      try {
        if (!waitForStoryCardReplan(updated)) rescheduleIfNeeded(backendDb, config, actorId, draftId, updated);
      } catch (error) {
        restoreDraftContent(backendDb, draftId, draft, input);
        throw error;
      }
      recordEditEvent(backendDb, draftId, input);
    },
  };
}

function waitForStoryCardReplan(draft: DraftRecord): boolean {
  if (draft.status !== "scheduled" || (draft.story_publish_mode !== "all" && draft.story_publish_mode !== "site_only")) return false;
  if (draftMedia(draft, "ru").length > 0 || draftMedia(draft, "en").length > 0) return false;
  return Object.entries(parseTargets(draft.targets_json)).some(([target, enabled]) => enabled && isStoryTarget(target));
}

function editDraftContent(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, input: EditInput): DraftRecord {
  const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now(), input.locale);
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
  return draft;
}

function restoreDraftContent(backendDb: BackendDb, draftId: number, draft: DraftRecord, input: EditInput): void {
  const ru = input.locale === "ru";
  const patch: DraftPatch = { updatedAt: backendDb.clock.now().toISOString() };
  if (input.clearMedia) patch[ru ? "mediaRuJson" : "mediaEnJson"] = ru ? draft.media_ru_json : draft.media_en_json;
  else {
    if (input.media.length) patch[ru ? "mediaRuJson" : "mediaEnJson"] = ru ? draft.media_ru_json : draft.media_en_json;
    if (!input.replaceMediaOnly && input.text) {
      if (ru) patch.textRu = draft.text_ru;
      else patch.textEnApproved = draft.text_en_approved;
      patch[ru ? "textRuEntitiesJson" : "textEnEntitiesJson"] = ru ? draft.text_ru_entities_json : draft.text_en_entities_json;
      patch.threadsChainApproved = draft.threads_chain_approved;
    }
  }
  backendDb.drafts.update(draftId, patch);
  backendDb.storyCards.queue(draftId);
}

function recordEditEvent(backendDb: BackendDb, draftId: number, input: EditInput): void {
  recordDomainEvent(backendDb.events, {
    ref: `draft:${draftId}`,
    type: "content.draft.edited",
    severity: "info",
    message: `Draft #${draftId} content updated`,
    details: {
      locale: input.locale,
      media_changed: input.media.length > 0 || Boolean(input.clearMedia),
      text_changed: !input.replaceMediaOnly,
    },
  });
}

function saveTargets(backendDb: BackendDb, draftId: number, targets: Record<string, boolean>): void {
  backendDb.drafts.update(draftId, { targetsJson: JSON.stringify(targets), updatedAt: backendDb.clock.now().toISOString() });
}

function saveTargetsAndReschedule(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  draft: DraftRecord,
  targets: Record<string, boolean>,
): void {
  try {
    saveTargets(backendDb, draftId, targets);
    rescheduleIfNeeded(backendDb, config, actorId, draftId, draft);
  } catch (error) {
    // Replanning is durable and transactional, but target selection is owned by
    // the draft row. Restore it if validation or queue hand-off rejects the new
    // selection so the draft cannot advertise targets its jobs do not represent.
    backendDb.drafts.update(draftId, {
      targetsJson: draft.targets_json,
      updatedAt: backendDb.clock.now().toISOString(),
    });
    throw error;
  }
}

function rescheduleIfNeeded(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, draft: DraftRecord): void {
  if (draft.status !== "scheduled") return;
  schedulePost(backendDb, config, actorId, draftId, {
    ruAt: scheduledDate(draft.scheduled_at),
    enAt: scheduledDate(draft.scheduled_en_at),
    allowPast: true,
  });
}

function schedulePost(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, input: PostScheduleInput): number {
  const draft = requireMutableDraft(backendDb, config, actorId, draftId);
  const now = backendDb.clock.now();
  for (const [locale, value] of [
    ["ru", input.ruAt],
    ["en", input.enAt],
  ] as const) {
    if (!value) continue;
    const existing = locale === "ru" ? scheduledDate(draft.scheduled_at) : scheduledDate(draft.scheduled_en_at);
    const preservesExistingSchedule = draft.status === "scheduled" && existing?.getTime() === value.getTime();
    if (input.allowPast || input.immediateLocale === locale || preservesExistingSchedule) assertValidScheduleDate(value);
    else assertFutureSchedule(value, now);
  }
  const postId = publishDraftToQueue(backendDb, draftId, {
    mode: "scheduled",
    ruAt: input.ruAt,
    enAt: input.enAt,
    ...(input.immediateLocale ? { immediateLocale: input.immediateLocale } : {}),
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
    ruAt: scope === "en" ? scheduledDate(draft.scheduled_at) : value,
    enAt: scope === "ru" ? scheduledDate(draft.scheduled_en_at) : value,
  };
}

/** Reads a persisted schedule column as a Date, treating an unset or unparsable
 * value as no schedule rather than an Invalid Date. */
export function scheduledDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
