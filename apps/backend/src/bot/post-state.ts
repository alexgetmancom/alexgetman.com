import { and, eq, isNull } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { adminState } from "../db/schema.js";

type PostAdminState = { action: string | null; draft_id: number | null; control_message_id: number | null };

export function getPostAdminState(backendDb: BackendDb, adminId: number): PostAdminState | null {
  return (
    backendDb.db
      .select({ action: adminState.action, draft_id: adminState.draftId, control_message_id: adminState.controlMessageId })
      .from(adminState)
      .where(eq(adminState.adminId, adminId))
      .get() ?? null
  );
}

export function setPostAdminState(
  backendDb: BackendDb,
  adminId: number,
  action: string | null = null,
  draftId: number | null = null,
  controlMessageId: number | null = null,
): void {
  const updatedAt = new Date().toISOString();
  backendDb.db
    .insert(adminState)
    .values({ adminId, action, draftId, controlMessageId, updatedAt })
    .onConflictDoUpdate({ target: adminState.adminId, set: { action, draftId, controlMessageId, updatedAt } })
    .run();
}

export function clearPostAdminState(backendDb: BackendDb, adminId: number): void {
  setPostAdminState(backendDb, adminId);
}

/** Do not erase a newer user action while an older asynchronous album completes. */
export function clearPostAdminStateIfCurrent(
  backendDb: BackendDb,
  adminId: number,
  action: string | null,
  draftId: number | null,
): boolean {
  if (!action) return false;
  const result = backendDb.db
    .update(adminState)
    .set({ action: null, draftId: null, controlMessageId: null, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(adminState.adminId, adminId),
        eq(adminState.action, action),
        draftId == null ? isNull(adminState.draftId) : eq(adminState.draftId, draftId),
      ),
    )
    .returning({ adminId: adminState.adminId })
    .get();
  return result != null;
}

export function startPostDialog(backendDb: BackendDb, adminId: number): void {
  setPostAdminState(backendDb, adminId, "new_post");
}
