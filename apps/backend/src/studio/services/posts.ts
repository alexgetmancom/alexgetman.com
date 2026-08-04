import type { DraftPatch, DraftRecord } from "../../application/ports.js";
import { isStoryTarget, PRESETS, presetName, TARGETS } from "../../botTargets.js";
import { effectivePostTargets, registeredPostTargetIds } from "../../channels/registry.js";
import { createDraftFromMessage } from "../../content/index.js";
import type { DraftMessage } from "../../content/message.js";
import type { BackendDb } from "../../db/client.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { publishDraftToQueue } from "../../publishing/publication-workflow.js";
import { parseTargets } from "../../publishing/targets.js";
import { type StoryPublishMode, setStoryPublishMode } from "../../story-cards/store.js";
import { draftMedia, requireMutableDraft, requireOwnedDraft, requirePostEditAllowed } from "./post-access.js";
import { postMediaService } from "./post-media.js";
import { postQueryService } from "./post-queries.js";
import { postSchedulingService, replanScheduledPostAfterMutation, scheduledDate } from "./post-scheduling.js";

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
  const scheduling = postSchedulingService(backendDb, config);
  const media = postMediaService(backendDb, config);
  return {
    create(actorId: number, message: DraftMessage): number {
      return createDraftFromMessage(backendDb, actorId, message);
    },
    ...queries,
    ...scheduling,
    ...media,
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
      saveTargetsAndReschedule(backendDb, scheduling, actorId, draftId, draft, targets);
    },
    cycleMode(actorId: number, draftId: number): keyof typeof PRESETS {
      const draft = requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now());
      const targets = parseTargets(draft.targets_json);
      const current = presetName(targets);
      const next = current === "full" ? "ru" : current === "ru" ? "en" : current === "en" ? "tg" : "full";
      const preset = effectivePostTargets(backendDb, PRESETS[next] ?? {});
      if (!preset) throw new StudioError("err.post-mode");
      saveTargetsAndReschedule(backendDb, scheduling, actorId, draftId, draft, preset);
      return next;
    },
    edit(actorId: number, draftId: number, input: EditInput): void {
      const draft = editDraftContent(backendDb, config, actorId, draftId, input);
      const updated = backendDb.drafts.get(draftId) ?? draft;
      try {
        if (!waitForStoryCardReplan(updated)) rescheduleIfNeeded(scheduling, actorId, draftId, updated);
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
  scheduling: ReturnType<typeof postSchedulingService>,
  actorId: number,
  draftId: number,
  draft: DraftRecord,
  targets: Record<string, boolean>,
): void {
  try {
    saveTargets(backendDb, draftId, targets);
    rescheduleIfNeeded(scheduling, actorId, draftId, draft);
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

function rescheduleIfNeeded(
  scheduling: ReturnType<typeof postSchedulingService>,
  actorId: number,
  draftId: number,
  draft: DraftRecord,
): void {
  if (draft.status !== "scheduled") return;
  scheduling.schedule(actorId, draftId, {
    ruAt: scheduledDate(draft.scheduled_at),
    enAt: scheduledDate(draft.scheduled_en_at),
    allowPast: true,
  });
}
