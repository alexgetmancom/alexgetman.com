import { eq } from "drizzle-orm";
import {
  cancelDraft,
  cancelRemainingPostJobs,
  createDraftFromMessage,
  publishDraftToQueue,
  requireDraft,
  setDraftControlCard,
} from "../../bot/drafts.js";
import type { DraftMessage } from "../../bot/message.js";
import { PRESETS, TARGETS } from "../../botTargets.js";
import type { BackendDb } from "../../db/client.js";
import { drafts } from "../../db/schema.js";
import { rebalanceScheduledDrafts } from "../../publishing/schedule.js";
import { parseTargets } from "../../publishing/targets.js";
import { postProgressState } from "./post-progress.js";

type ScheduleInput = { ruAt: Date | null; enAt: Date | null };
type EditInput = { locale: "ru" | "en"; text: string; entities: unknown[]; media: Record<string, unknown>[]; replaceMediaOnly?: boolean };

/** Commands for post drafts. These are deliberately transport-free and become the
 * single entry point for Telegram, Web Studio and later MCP mutations. */
export function postService(backendDb: BackendDb) {
  return {
    create(actorId: number, message: DraftMessage): number {
      return createDraftFromMessage(backendDb, actorId, message);
    },
    details(actorId: number, draftId: number) {
      return requireOwnedDraft(backendDb, actorId, draftId);
    },
    publishNow(actorId: number, draftId: number): number {
      requireOwnedDraft(backendDb, actorId, draftId);
      return publishDraftToQueue(backendDb, draftId);
    },
    schedule(actorId: number, draftId: number, input: ScheduleInput): number {
      requireOwnedDraft(backendDb, actorId, draftId);
      const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ...input });
      rebalanceScheduledDrafts(backendDb);
      return postId;
    },
    cancel(actorId: number, draftId: number): void {
      requireOwnedDraft(backendDb, actorId, draftId);
      cancelDraft(backendDb, draftId);
    },
    cancelRemaining(actorId: number, draftId: number): void {
      requireOwnedDraft(backendDb, actorId, draftId);
      cancelRemainingPostJobs(backendDb, draftId);
    },
    progress(actorId: number, draftId: number) {
      requireOwnedDraft(backendDb, actorId, draftId);
      return postProgressState(backendDb, draftId);
    },
    setControlCard(actorId: number, draftId: number, chatId: number, messageId: number): void {
      requireOwnedDraft(backendDb, actorId, draftId);
      setDraftControlCard(backendDb, draftId, chatId, messageId);
    },
    toggleTarget(actorId: number, draftId: number, target: string): void {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      if (!TARGETS.some(([id]) => id === target)) throw new Error("Unknown publication target.");
      const targets = parseTargets(draft.targets_json);
      targets[target] = !targets[target];
      saveTargets(backendDb, draftId, targets);
    },
    cycleMode(actorId: number, draftId: number): keyof typeof PRESETS {
      const draft = requireOwnedDraft(backendDb, actorId, draftId);
      const targets = parseTargets(draft.targets_json);
      const current = presetName(targets);
      const next = current === "full" ? "ru" : current === "ru" ? "en" : current === "en" ? "tg" : "full";
      const preset = PRESETS[next];
      if (!preset) throw new Error("Post mode is not configured.");
      saveTargets(backendDb, draftId, preset);
      return next;
    },
    editContent(actorId: number, draftId: number, input: EditInput): void {
      requireOwnedDraft(backendDb, actorId, draftId);
      const cleanText = input.text.trim().toLowerCase();
      const clearMedia = cleanText === "/delmedia" || cleanText === "очистить" || cleanText === "без медиа" || cleanText === "clear media";
      const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      const ru = input.locale === "ru";
      if (clearMedia) update[ru ? "mediaRuJson" : "mediaEnJson"] = null;
      else {
        if (input.media.length) update[ru ? "mediaRuJson" : "mediaEnJson"] = JSON.stringify(input.media);
        if (!input.replaceMediaOnly && input.text) {
          update[ru ? "textRu" : "textEnApproved"] = input.text;
          update[ru ? "textRuEntitiesJson" : "textEnEntitiesJson"] = JSON.stringify(input.entities);
        }
      }
      if (Object.keys(update).length === 1) throw new Error("No text or media detected for editing.");
      backendDb.db.update(drafts).set(update).where(eq(drafts.id, draftId)).run();
    },
  };
}

function requireOwnedDraft(backendDb: BackendDb, actorId: number, draftId: number) {
  const draft = requireDraft(backendDb, draftId);
  if (draft.admin_id !== actorId) throw new Error("Draft is not available to this user.");
  return draft;
}

function saveTargets(backendDb: BackendDb, draftId: number, targets: Record<string, boolean>): void {
  backendDb.db
    .update(drafts)
    .set({ targetsJson: JSON.stringify(targets), updatedAt: new Date().toISOString() })
    .where(eq(drafts.id, draftId))
    .run();
}

function presetName(targets: Record<string, boolean>): keyof typeof PRESETS | "manual" {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (TARGETS.every(([target]) => Boolean(targets[target]) === Boolean(preset[target]))) return name as keyof typeof PRESETS;
  }
  return "manual";
}
