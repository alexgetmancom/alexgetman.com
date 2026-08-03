import type { ApplicationPorts, DraftRecord } from "../../application/ports.js";
import { requireDraft } from "../../content/drafts.js";
import { parseArrayValue } from "../../content/message.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { isPostDraftMutable } from "../../publishing/state.js";
import { canAccessStudioOwner } from "../access.js";

/** Shared access and decoding rules for post use cases. */
export function requireOwnedDraft(ports: Pick<ApplicationPorts, "drafts">, config: BackendConfig, actorId: number, draftId: number) {
  const draft = requireDraft(ports, draftId);
  if (!canAccessStudioOwner(config, actorId, draft.actor_id)) throw new StudioError("err.post-not-yours");
  return draft;
}

export function requireMutableDraft(
  ports: Pick<ApplicationPorts, "drafts">,
  config: BackendConfig,
  actorId: number,
  draftId: number,
): DraftRecord {
  const draft = requireOwnedDraft(ports, config, actorId, draftId);
  if (!isPostDraftMutable(draft.status)) throw new StudioError("err.post-locked");
  return draft;
}

export function draftMedia(draft: DraftRecord, locale: "ru" | "en"): Record<string, unknown>[] {
  return parseArrayValue(locale === "ru" ? draft.media_ru_json : draft.media_en_json);
}
