import { and, eq, isNull, sql } from "drizzle-orm";
import type { StudioPostAdminStateStore } from "../../application/ports.js";
import { adminState } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for the Telegram post conversation's durable state. */
export function createStudioPostAdminStateStore(db: BackendDatabase): StudioPostAdminStateStore {
  return {
    get(actorId) {
      const row = db.select().from(adminState).where(eq(adminState.actorId, actorId)).get();
      return row
        ? {
            action: row.action,
            draftId: row.draftId,
            controlMessageId: row.controlMessageId,
            revision: row.revision,
            updatedAt: row.updatedAt,
            expiresAt: row.expiresAt,
          }
        : null;
    },

    save(input) {
      const previous = db.select({ revision: adminState.revision }).from(adminState).where(eq(adminState.actorId, input.actorId)).get();
      const revision = (previous?.revision ?? 0) + 1;
      db.insert(adminState)
        .values({ ...input, revision })
        .onConflictDoUpdate({
          target: adminState.actorId,
          set: {
            action: input.action,
            draftId: input.draftId,
            controlMessageId: input.controlMessageId,
            revision,
            updatedAt: input.updatedAt,
            expiresAt: input.expiresAt,
          },
        })
        .run();
      return revision;
    },

    clearIfCurrent(input) {
      return (
        db
          .update(adminState)
          .set({
            action: null,
            draftId: null,
            controlMessageId: null,
            revision: sql`${adminState.revision} + 1`,
            updatedAt: input.updatedAt,
            expiresAt: null,
          })
          .where(
            and(
              eq(adminState.actorId, input.actorId),
              eq(adminState.action, input.action),
              input.draftId == null ? isNull(adminState.draftId) : eq(adminState.draftId, input.draftId),
              ...(input.expectedRevision == null ? [] : [eq(adminState.revision, input.expectedRevision)]),
            ),
          )
          .returning({ actorId: adminState.actorId })
          .get() != null
      );
    },

    retire(actorId, updatedAt) {
      db.update(adminState)
        .set({
          action: null,
          draftId: null,
          controlMessageId: null,
          revision: sql`${adminState.revision} + 1`,
          updatedAt,
          expiresAt: null,
        })
        .where(eq(adminState.actorId, actorId))
        .run();
    },
  };
}
