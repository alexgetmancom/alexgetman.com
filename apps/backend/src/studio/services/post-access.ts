import type { ApplicationPorts, DraftRecord } from "../../application/ports.js";
import { requireDraft } from "../../content/drafts.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { canAccessStudioOwner } from "../access.js";

/** Shared access and decoding rules for post use cases. */
export function requireOwnedDraft(ports: Pick<ApplicationPorts, "drafts">, config: BackendConfig, actorId: number, draftId: number) {
  const draft = requireDraft(ports, draftId);
  if (!canAccessStudioOwner(config, actorId, draft.actor_id)) throw new StudioError("err.post-not-yours");
  return draft;
}

/** A legacy or truncated JSON column must surface as an empty list, not as a raw SyntaxError. */
export function parseJsonArray(value: string | null): Record<string, unknown>[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
  } catch {
    return [];
  }
}

export function draftMedia(draft: DraftRecord, locale: "ru" | "en"): Record<string, unknown>[] {
  return parseJsonArray(locale === "ru" ? draft.media_ru_json : draft.media_en_json);
}

export function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
