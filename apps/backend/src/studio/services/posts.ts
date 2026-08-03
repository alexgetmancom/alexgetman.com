import type { DraftPatch } from "../../application/ports.js";
import { PRESETS, presetName, TARGETS } from "../../botTargets.js";
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
import { requireOwnedDraft } from "./post-access.js";
import { postMediaService } from "./post-media.js";
import { postQueryService } from "./post-queries.js";
import { postSchedulingService } from "./post-scheduling.js";

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
  };
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

function saveTargets(backendDb: BackendDb, draftId: number, targets: Record<string, boolean>): void {
  backendDb.drafts.update(draftId, { targetsJson: JSON.stringify(targets), updatedAt: backendDb.clock.now().toISOString() });
}
