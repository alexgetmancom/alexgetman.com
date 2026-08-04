import type { BackendDb } from "../db/client.js";
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
  const row = backendDb.conversationSessions.get(actorId, "post");
  if (!row) return null;
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : Date.parse(row.updatedAt) + POST_STATE_TTL_MS;
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
    draft_id: row.draftId,
    control_message_id: row.controlMessageId,
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
  const updatedAt = new Date().toISOString();
  const expiresAt = parsedAction ? new Date(Date.now() + POST_STATE_TTL_MS).toISOString() : null;
  return backendDb.conversationSessions.save({
    actorId,
    kind: "post",
    draftId,
    action: parsedAction,
    step: null,
    selectedTargets: [],
    data: {},
    controlMessageId,
    active: parsedAction ? 1 : 0,
    updatedAt,
    expiresAt,
  });
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
  return backendDb.conversationSessions.clearIfCurrent({
    actorId,
    kind: "post",
    action,
    draftId,
    expectedRevision,
    updatedAt: new Date().toISOString(),
  });
}

export function startPostDialog(backendDb: BackendDb, actorId: number): number {
  return setPostAdminState(backendDb, actorId, "new_post");
}

function retirePostAdminState(backendDb: BackendDb, actorId: number): void {
  backendDb.conversationSessions.retire(actorId, "post", new Date().toISOString());
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
