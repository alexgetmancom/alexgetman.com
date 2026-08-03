import { and, eq, isNull } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { adminState } from "../db/schema.js";

const POST_STATE_TTL_MS = 30 * 60_000;
export type PostAdminAction =
  | "new_post"
  | "edit_sources"
  | "edit_ru"
  | "edit_en"
  | "replace_ru_media"
  | "replace_en_media"
  | `schedule_manual_${"ru" | "en"}`
  | `schedule_confirm_${"ru" | "en"}_${string}`;
export type PostAdminState = {
  action: PostAdminAction | null;
  draft_id: number | null;
  control_message_id: number | null;
};

export function getPostAdminState(backendDb: BackendDb, actorId: number): PostAdminState | null {
  const row = unsafeDb(backendDb)
    .db.select({
      action: adminState.action,
      draft_id: adminState.draftId,
      control_message_id: adminState.controlMessageId,
      updated_at: adminState.updatedAt,
      expires_at: adminState.expiresAt,
    })
    .from(adminState)
    .where(eq(adminState.actorId, actorId))
    .get();
  if (!row) return null;
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Date.parse(row.updated_at) + POST_STATE_TTL_MS;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    unsafeDb(backendDb).db.delete(adminState).where(eq(adminState.actorId, actorId)).run();
    return null;
  }
  const action = parsePostAction(row.action);
  if (row.action !== null && !action) {
    unsafeDb(backendDb).db.delete(adminState).where(eq(adminState.actorId, actorId)).run();
    return null;
  }
  return {
    action,
    draft_id: row.draft_id,
    control_message_id: row.control_message_id,
  };
}

export function setPostAdminState(
  backendDb: BackendDb,
  actorId: number,
  action: PostAdminAction | string | null = null,
  draftId: number | null = null,
  controlMessageId: number | null = null,
): void {
  const parsedAction = parsePostAction(action);
  if (action !== null && !parsedAction) throw new Error(`Unknown post admin action: ${action}`);
  const updatedAt = new Date().toISOString();
  const expiresAt = parsedAction ? new Date(Date.now() + POST_STATE_TTL_MS).toISOString() : null;
  unsafeDb(backendDb)
    .db.insert(adminState)
    .values({ actorId, action: parsedAction, draftId, controlMessageId, updatedAt, expiresAt })
    .onConflictDoUpdate({ target: adminState.actorId, set: { action: parsedAction, draftId, controlMessageId, updatedAt, expiresAt } })
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
    .set({ action: null, draftId: null, controlMessageId: null, updatedAt: new Date().toISOString(), expiresAt: null })
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

function parsePostAction(value: string | null): PostAdminAction | null {
  if (
    value === "new_post" ||
    value === "edit_sources" ||
    value === "edit_ru" ||
    value === "edit_en" ||
    value === "replace_ru_media" ||
    value === "replace_en_media"
  )
    return value;
  if (/^schedule_manual_(ru|en)$/.test(value ?? "")) return value as PostAdminAction;
  if (/^schedule_confirm_(ru|en)_.+$/.test(value ?? "")) return value as PostAdminAction;
  return null;
}
