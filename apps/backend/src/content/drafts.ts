import { eq } from "drizzle-orm";
import { DEFAULT_TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { drafts } from "../db/schema.js";
import { recordDomainEvent } from "../domain/events.js";
import type { DraftMessage } from "./message.js";

/** Content aggregate for a draft before it enters a publication plan. */
export function createDraftFromMessage(backendDb: BackendDb, adminId: number, message: DraftMessage): number {
  const now = new Date().toISOString();
  const created = backendDb.db
    .insert(drafts)
    .values({
      adminId,
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
    details: { owner_id: adminId, media_count: message.media.length },
  });
  return created.id;
}

export function requireDraft(backendDb: BackendDb, draftId: number) {
  const draft = backendDb.db
    .select({
      id: drafts.id,
      admin_id: drafts.adminId,
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
      text_ru_entities_json: drafts.textRuEntitiesJson,
      text_en_entities_json: drafts.textEnEntitiesJson,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  if (!draft) throw new Error(`draft ${draftId} not found`);
  return draft;
}
