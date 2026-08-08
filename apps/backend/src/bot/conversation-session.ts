import type { ConversationSessionKind, ConversationSessionRecord, ConversationSessionStore } from "../application/ports.js";
import type { BackendDb } from "../db/client.js";

export const CONVERSATION_SESSION_TTL_MS = 30 * 60_000;
type ConversationSessionSave = Parameters<ConversationSessionStore["save"]>[0];

/** Returns a durable conversation row and retires an expired one. */
export function activeConversationSession(
  backendDb: BackendDb,
  actorId: number,
  kind: ConversationSessionKind,
  ttlMs = CONVERSATION_SESSION_TTL_MS,
): ConversationSessionRecord | null {
  const row = backendDb.conversationSessions.get(actorId, kind);
  if (!row) return null;
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : Date.parse(row.updatedAt) + ttlMs;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    retireConversationSession(backendDb, actorId, kind);
    return null;
  }
  return row;
}

/** Persists one conversational transition through the application port. */
export function saveConversationSession(backendDb: BackendDb, input: ConversationSessionSave): number {
  return backendDb.conversationSessions.save(input);
}

/** Retires the current workflow and advances its revision. */
export function retireConversationSession(backendDb: BackendDb, actorId: number, kind: ConversationSessionKind): void {
  backendDb.conversationSessions.retire(actorId, kind, new Date().toISOString());
}

/** Clears a workflow only when the caller still owns the state it read. */
export function clearConversationSessionIfCurrent(
  backendDb: BackendDb,
  input: Parameters<ConversationSessionStore["clearIfCurrent"]>[0],
): boolean {
  return backendDb.conversationSessions.clearIfCurrent(input);
}
