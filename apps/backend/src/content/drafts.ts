import { eq } from "drizzle-orm";
import { DEFAULT_TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { drafts } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import { queueDraftStoryCards } from "../story-cards/store.js";
import type { DraftMessage } from "./message.js";

/** Content aggregate for a draft before it enters a publication plan. */
export function createDraftFromMessage(backendDb: BackendDb, actorId: number, message: DraftMessage): number {
  const now = new Date().toISOString();
  const created = backendDb.db
    .insert(drafts)
    .values({
      actorId,
      status: "needs_review",
      textRu: message.text,
      textEnMachine: message.textEn ?? message.text,
      textEnApproved: message.textEn ?? message.text,
      targetsJson: JSON.stringify(DEFAULT_TARGETS),
      mediaRuJson: message.media.length ? JSON.stringify(message.media) : null,
      textRuEntitiesJson: JSON.stringify(message.entities),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: drafts.id })
    .get();
  if (!created) throw new Error("draft insert did not return an id");
  recordDomainEvent(backendDb, {
    ref: `draft:${created.id}`,
    type: "content.draft.created",
    severity: "info",
    message: `Draft #${created.id} created`,
    details: { owner_id: actorId, media_count: message.media.length },
  });
  queueDraftStoryCards(backendDb, created.id);
  return created.id;
}

export function requireDraft(backendDb: BackendDb, draftId: number) {
  const draft = backendDb.db
    .select({
      id: drafts.id,
      actor_id: drafts.actorId,
      status: drafts.status,
      text_ru: drafts.textRu,
      text_en_machine: drafts.textEnMachine,
      text_en_approved: drafts.textEnApproved,
      targets_json: drafts.targetsJson,
      media_ru_json: drafts.mediaRuJson,
      media_en_json: drafts.mediaEnJson,
      channel_message_id: drafts.channelMessageId,
      scheduled_at: drafts.scheduledAt,
      scheduled_en_at: drafts.scheduledEnAt,
      post_id: drafts.postId,
      text_ru_entities_json: drafts.textRuEntitiesJson,
      text_en_entities_json: drafts.textEnEntitiesJson,
      threads_chain_approved: drafts.threadsChainApproved,
      story_publish_mode: drafts.storyPublishMode,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  if (!draft) throw new Error(`draft ${draftId} not found`);
  return draft;
}
