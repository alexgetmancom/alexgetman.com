import { and, eq, isNull, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { adminState } from "../db/schema.js";
import { StudioError } from "../foundation/errors.js";
import { requireSessionRevision } from "./session-fsm.js";

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
  revision: number;
};

export function getPostAdminState(backendDb: BackendDb, actorId: number): PostAdminState | null {
  const row = unsafeDb(backendDb)
    .db.select({
      action: adminState.action,
      draft_id: adminState.draftId,
      control_message_id: adminState.controlMessageId,
      revision: adminState.revision,
      updated_at: adminState.updatedAt,
      expires_at: adminState.expiresAt,
    })
    .from(adminState)
    .where(eq(adminState.actorId, actorId))
    .get();
  if (!row) return null;
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : Date.parse(row.updated_at) + POST_STATE_TTL_MS;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    retirePostAdminState(backendDb, actorId);
    return null;
  }
  const action = parsePostAction(row.action);
  if (row.action !== null && !action) {
    retirePostAdminState(backendDb, actorId);
    return null;
  }
  return {
    action,
    draft_id: row.draft_id,
    control_message_id: row.control_message_id,
    revision: row.revision,
  };
}

export function setPostAdminState(
  backendDb: BackendDb,
  actorId: number,
  action: PostAdminAction | string | null = null,
  draftId: number | null = null,
  controlMessageId: number | null = null,
): number {
  const parsedAction = parsePostAction(action);
  if (action !== null && !parsedAction) throw new Error(`Unknown post admin action: ${action}`);
  const previous = unsafeDb(backendDb)
    .db.select({ revision: adminState.revision })
    .from(adminState)
    .where(eq(adminState.actorId, actorId))
    .get();
  const revision = (previous?.revision ?? 0) + 1;
  const updatedAt = new Date().toISOString();
  const expiresAt = parsedAction ? new Date(Date.now() + POST_STATE_TTL_MS).toISOString() : null;
  unsafeDb(backendDb)
    .db.insert(adminState)
    .values({ actorId, action: parsedAction, draftId, controlMessageId, revision, updatedAt, expiresAt })
    .onConflictDoUpdate({
      target: adminState.actorId,
      set: { action: parsedAction, draftId, controlMessageId, revision, updatedAt, expiresAt },
    })
    .run();
  return revision;
}

export function clearPostAdminState(backendDb: BackendDb, actorId: number): number {
  return setPostAdminState(backendDb, actorId);
}

/** Do not erase a newer user action while an older asynchronous album completes. */
export function clearPostAdminStateIfCurrent(
  backendDb: BackendDb,
  actorId: number,
  action: string | null,
  draftId: number | null,
  expectedRevision?: number | null,
): boolean {
  if (!action) return false;
  const result = unsafeDb(backendDb)
    .db.update(adminState)
    .set({
      action: null,
      draftId: null,
      controlMessageId: null,
      revision: sql`${adminState.revision} + 1`,
      updatedAt: new Date().toISOString(),
      expiresAt: null,
    })
    .where(
      and(
        eq(adminState.actorId, actorId),
        eq(adminState.action, action),
        draftId == null ? isNull(adminState.draftId) : eq(adminState.draftId, draftId),
        ...(expectedRevision == null ? [] : [eq(adminState.revision, expectedRevision)]),
      ),
    )
    .returning({ actorId: adminState.actorId })
    .get();
  return result != null;
}

export function startPostDialog(backendDb: BackendDb, actorId: number): number {
  return setPostAdminState(backendDb, actorId, "new_post");
}

function retirePostAdminState(backendDb: BackendDb, actorId: number): void {
  unsafeDb(backendDb)
    .db.update(adminState)
    .set({
      action: null,
      draftId: null,
      controlMessageId: null,
      revision: sql`${adminState.revision} + 1`,
      updatedAt: new Date().toISOString(),
      expiresAt: null,
    })
    .where(eq(adminState.actorId, actorId))
    .run();
}

export function requireCurrentPostSession(backendDb: BackendDb, actorId: number, expectedRevision: number | null): PostAdminState {
  const state = getPostAdminState(backendDb, actorId);
  requireSessionRevision(state?.revision, expectedRevision);
  if (!state) throw new StudioError("action.session-stale");
  return state;
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
