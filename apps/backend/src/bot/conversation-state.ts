import type { ConversationSessionKind, ConversationSessionRecord } from "../application/ports.js";
import type { BackendDb } from "../db/client.js";
import {
  activeConversationSession,
  CONVERSATION_SESSION_TTL_MS,
  clearConversationSessionIfCurrent,
  retireConversationSession,
  saveConversationSession,
} from "./conversation-session.js";

/** The single durable state shape used by every publication conversation. */
export type ConversationState = {
  kind: ConversationSessionKind;
  draftId: number | null;
  step: string;
  data: Record<string, unknown>;
  controlMessageId: number | null;
  revision: number;
};

export type ConversationStateInput = Omit<ConversationState, "revision"> & { revision?: number | null };

export function getConversationState(backendDb: BackendDb, actorId: number, kind: ConversationSessionKind): ConversationState | null {
  const row = activeConversationSession(backendDb, actorId, kind, CONVERSATION_SESSION_TTL_MS);
  if (!row || row.active === 0) return null;
  if (!row.step) {
    retireConversationSession(backendDb, actorId, kind);
    return null;
  }
  return stateFromRow(row);
}

/** Returns the current publication conversation, if one exists. */
export function getActiveConversationState(backendDb: BackendDb, actorId: number): ConversationState | null {
  return getConversationState(backendDb, actorId, "video") ?? getConversationState(backendDb, actorId, "post");
}

export function saveConversationState(backendDb: BackendDb, actorId: number, input: ConversationStateInput): ConversationState {
  const existing = backendDb.conversationSessions.get(actorId, input.kind);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CONVERSATION_SESSION_TTL_MS).toISOString();
  const data = { ...input.data };
  const selectedTargets = Array.isArray(data.selectedTargets)
    ? data.selectedTargets.filter((value): value is string => typeof value === "string")
    : [];

  // A person can have one active publication conversation. Starting a new one
  // retires the other kind before the new state is written.
  retireConversationSession(backendDb, actorId, input.kind === "post" ? "video" : "post");
  const revision = saveConversationSession(backendDb, {
    actorId,
    kind: input.kind,
    draftId: input.draftId,
    step: input.step,
    selectedTargets,
    data,
    controlMessageId: input.controlMessageId,
    active: 1,
    ...(input.revision == null ? {} : { expectedRevision: input.revision }),
    preserveRevision: existing != null && !hasSemanticChange(existing, input, selectedTargets),
    updatedAt: now,
    expiresAt,
  });
  return { ...input, revision };
}

export function clearConversationState(backendDb: BackendDb, actorId: number, kind: ConversationSessionKind): void {
  retireConversationSession(backendDb, actorId, kind);
}

export function clearConversationStateIfCurrent(
  backendDb: BackendDb,
  state: Pick<ConversationState, "kind" | "step" | "draftId">,
  actorId: number,
  expectedRevision?: number | null,
): boolean {
  return clearConversationSessionIfCurrent(backendDb, {
    actorId,
    kind: state.kind,
    step: state.step,
    draftId: state.draftId,
    expectedRevision,
    updatedAt: new Date().toISOString(),
  });
}

export function requireConversationState(
  backendDb: BackendDb,
  actorId: number,
  kind: ConversationSessionKind,
  expectedRevision: number | null,
): ConversationState {
  const state = getConversationState(backendDb, actorId, kind);
  if (!state || (expectedRevision != null && state.revision !== expectedRevision)) throw new Error("action.session-stale");
  return state;
}

function stateFromRow(row: ConversationSessionRecord): ConversationState {
  const data = { ...row.data };
  if (row.selectedTargets.length > 0 && !Array.isArray(data.selectedTargets)) data.selectedTargets = row.selectedTargets;
  return {
    kind: row.kind,
    draftId: row.draftId,
    step: row.step as string,
    data,
    controlMessageId: row.controlMessageId,
    revision: row.revision,
  };
}

function hasSemanticChange(row: ConversationSessionRecord, input: ConversationStateInput, selectedTargets: string[]): boolean {
  return (
    row.active !== 1 ||
    row.draftId !== input.draftId ||
    row.step !== input.step ||
    JSON.stringify(row.selectedTargets) !== JSON.stringify(selectedTargets) ||
    JSON.stringify(row.data) !== JSON.stringify(input.data)
  );
}
