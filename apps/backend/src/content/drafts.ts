import type { ApplicationPorts } from "../application/ports.js";
import { DEFAULT_TARGETS } from "../botTargets.js";
import { recordDomainEvent } from "../domain/events.js";
import type { DraftMessage } from "./message.js";

/** Content aggregate for a draft before it enters a publication plan. */
export function createDraftFromMessage(ports: ApplicationPorts, actorId: number, message: DraftMessage): number {
  const createdId = ports.drafts.create({
    actorId,
    textRu: message.text,
    textEnMachine: message.textEn ?? message.text,
    textEnApproved: message.textEnApproved ?? null,
    targetsJson: JSON.stringify(DEFAULT_TARGETS),
    mediaRuJson: message.media.length ? JSON.stringify(message.media) : null,
    textRuEntitiesJson: JSON.stringify(message.entities),
  });
  recordDomainEvent(ports.events, {
    ref: `draft:${createdId}`,
    type: "content.draft.created",
    severity: "info",
    message: `Draft #${createdId} created`,
    details: { owner_id: actorId, media_count: message.media.length },
  });
  ports.storyCards.queue(createdId);
  return createdId;
}

export function requireDraft(ports: Pick<ApplicationPorts, "drafts">, draftId: number) {
  const draft = ports.drafts.get(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  return draft;
}
