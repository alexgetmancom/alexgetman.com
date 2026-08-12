import type { ApplicationPorts, DraftRecord } from "../../application/ports.js";
import { parseArrayValue } from "../../content/message.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { isPostDraftMutable } from "../../publishing/state.js";
import { requireOwnedPublication } from "./publication-access.js";

/** Shared access and decoding rules for post use cases. */
export function requireOwnedDraft(ports: Pick<ApplicationPorts, "drafts">, config: BackendConfig, actorId: number, draftId: number) {
  return requireOwnedPublication(ports.drafts.get(draftId), config, actorId, `draft ${draftId} not found`, "err.post-not-yours");
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

/** Prevents payload-changing edits from racing a due publication. The schedule
 * command remains available so an operator can explicitly replan a draft; this
 * guard applies to content, media, target and policy mutations only. */
export function requirePostEditAllowed(
  ports: Pick<ApplicationPorts, "drafts">,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  now: Date,
  locale?: "ru" | "en",
): DraftRecord {
  const draft = requireMutableDraft(ports, config, actorId, draftId);
  const lockUntil = now.getTime() + config.POST_EDIT_LOCK_MINUTES * 60_000;
  const scheduledTimes = (
    locale === "ru" ? [draft.scheduled_at] : locale === "en" ? [draft.scheduled_en_at] : [draft.scheduled_at, draft.scheduled_en_at]
  )
    .filter((value): value is string => value != null)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (scheduledTimes.some((scheduledAt) => scheduledAt <= lockUntil)) throw new StudioError("err.post-too-close-to-publish");
  return draft;
}

export function draftMedia(draft: DraftRecord, locale: "ru" | "en"): Record<string, unknown>[] {
  return parseArrayValue(locale === "ru" ? draft.media_ru_json : draft.media_en_json);
}
