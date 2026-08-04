import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { ConversationSessionKind, ConversationSessionStore } from "../../application/ports.js";
import { StudioError } from "../../foundation/errors.js";
import { conversationSessions } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for durable Telegram conversation state. */
export function createConversationSessionStore(db: BackendDatabase): ConversationSessionStore {
  return {
    get(actorId, kind) {
      const row = db
        .select()
        .from(conversationSessions)
        .where(and(eq(conversationSessions.actorId, actorId), eq(conversationSessions.kind, kind)))
        .get();
      if (!row) return null;
      return {
        actorId: row.actorId,
        kind: row.kind as ConversationSessionKind,
        draftId: row.draftId,
        action: row.action,
        step: row.step,
        selectedTargets: row.selectedTargetsJson,
        data: row.dataJson,
        controlMessageId: row.controlMessageId,
        revision: row.revision,
        active: row.active,
        updatedAt: row.updatedAt,
        expiresAt: row.expiresAt,
      };
    },

    save(input) {
      const existing = db
        .select({ revision: conversationSessions.revision })
        .from(conversationSessions)
        .where(and(eq(conversationSessions.actorId, input.actorId), eq(conversationSessions.kind, input.kind)))
        .get();
      if (existing && input.expectedRevision != null && existing.revision !== input.expectedRevision)
        throw new StudioError("action.session-stale");
      const revision = existing && input.preserveRevision ? existing.revision : (existing?.revision ?? 0) + 1;
      db.insert(conversationSessions)
        .values({
          actorId: input.actorId,
          kind: input.kind,
          draftId: input.draftId,
          action: input.action,
          step: input.step,
          selectedTargetsJson: input.selectedTargets,
          dataJson: input.data,
          controlMessageId: input.controlMessageId,
          revision,
          active: input.active,
          updatedAt: input.updatedAt,
          expiresAt: input.expiresAt,
        })
        .onConflictDoUpdate({
          target: [conversationSessions.actorId, conversationSessions.kind],
          set: {
            draftId: input.draftId,
            action: input.action,
            step: input.step,
            selectedTargetsJson: input.selectedTargets,
            dataJson: input.data,
            controlMessageId: input.controlMessageId,
            revision,
            active: input.active,
            updatedAt: input.updatedAt,
            expiresAt: input.expiresAt,
          },
        })
        .run();
      return revision;
    },

    clearIfCurrent(input) {
      const expectedStep = input.step ?? input.action;
      if (!expectedStep) return false;
      return (
        db
          .update(conversationSessions)
          .set({
            draftId: null,
            action: null,
            step: null,
            selectedTargetsJson: [],
            dataJson: {},
            controlMessageId: null,
            revision: sql`${conversationSessions.revision} + 1`,
            active: 0,
            updatedAt: input.updatedAt,
            expiresAt: null,
          })
          .where(
            and(
              eq(conversationSessions.actorId, input.actorId),
              eq(conversationSessions.kind, input.kind),
              or(eq(conversationSessions.step, expectedStep), eq(conversationSessions.action, expectedStep)),
              input.draftId == null ? isNull(conversationSessions.draftId) : eq(conversationSessions.draftId, input.draftId),
              ...(input.expectedRevision == null ? [] : [eq(conversationSessions.revision, input.expectedRevision)]),
            ),
          )
          .returning({ actorId: conversationSessions.actorId })
          .get() != null
      );
    },

    retire(actorId, kind, updatedAt) {
      db.update(conversationSessions)
        .set({
          draftId: null,
          action: null,
          step: null,
          selectedTargetsJson: [],
          dataJson: {},
          controlMessageId: null,
          revision: sql`${conversationSessions.revision} + 1`,
          active: 0,
          updatedAt,
          expiresAt: null,
        })
        .where(and(eq(conversationSessions.actorId, actorId), eq(conversationSessions.kind, kind)))
        .run();
    },
  };
}
