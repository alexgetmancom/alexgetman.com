import { and, eq, isNull } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { adminState } from "../db/schema.js";

type PostAdminState = { action: string | null; draft_id: number | null; control_message_id: number | null };

export function getPostAdminState(backendDb: BackendDb, actorId: number): PostAdminState | null {
  return (
    unsafeDb(backendDb)
      .db.select({ action: adminState.action, draft_id: adminState.draftId, control_message_id: adminState.controlMessageId })
      .from(adminState)
      .where(eq(adminState.actorId, actorId))
      .get() ?? null
  );
}

export function setPostAdminState(
  backendDb: BackendDb,
  actorId: number,
  action: string | null = null,
  draftId: number | null = null,
  controlMessageId: number | null = null,
): void {
  const updatedAt = new Date().toISOString();
  unsafeDb(backendDb)
    .db.insert(adminState)
    .values({ actorId, action, draftId, controlMessageId, updatedAt })
    .onConflictDoUpdate({ target: adminState.actorId, set: { action, draftId, controlMessageId, updatedAt } })
    .run();
}

export function clearPostAdminState(backendDb: BackendDb, actorId: number): void {
  setPostAdminState(backendDb, actorId);
}

/** Do not erase a newer user action while an older asynchronous album completes. */
export function clearPostAdminStateIfCurrent(
  backendDb: BackendDb,
  actorId: number,
  action: string | null,
  draftId: number | null,
): boolean {
  if (!action) return false;
  const result = unsafeDb(backendDb)
    .db.update(adminState)
    .set({ action: null, draftId: null, controlMessageId: null, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(adminState.actorId, actorId),
        eq(adminState.action, action),
        draftId == null ? isNull(adminState.draftId) : eq(adminState.draftId, draftId),
      ),
    )
    .returning({ actorId: adminState.actorId })
    .get();
  return result != null;
}

export function startPostDialog(backendDb: BackendDb, actorId: number): void {
  setPostAdminState(backendDb, actorId, "new_post");
}
