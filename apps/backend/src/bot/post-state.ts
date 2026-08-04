import type { BackendDb } from "../db/client.js";
import { StudioError } from "../foundation/errors.js";
import {
  activeConversationSession,
  CONVERSATION_SESSION_TTL_MS,
  clearConversationSessionIfCurrent,
  retireConversationSession,
  saveConversationSession,
} from "./conversation-session.js";
import {
  POST_FLOW,
  type PostWizardStep,
  type PostWizardStepInput,
  postStepAction,
  postStepData,
  postStepName,
  resolvePostWizardStep,
} from "./post-fsm.js";
import { requireSessionRevision } from "./session-fsm.js";

export type PostAdminState = {
  action: string | null;
  step: PostWizardStep | null;
  draft_id: number | null;
  control_message_id: number | null;
  revision: number;
};

export function getPostAdminState(backendDb: BackendDb, actorId: number): PostAdminState | null {
  const row = activeConversationSession(backendDb, actorId, "post");
  if (!row) return null;
  const rawStep = row.step ?? row.action;
  const step = resolvePostWizardStep(rawStep, row.data);
  if (rawStep !== null && (!step || !POST_FLOW.steps[step.type])) {
    retirePostAdminState(backendDb, actorId);
    return null;
  }
  return {
    action: step ? postStepAction(step) : null,
    step,
    draft_id: row.draftId,
    control_message_id: row.controlMessageId,
    revision: row.revision,
  };
}

export function setPostAdminState(
  backendDb: BackendDb,
  actorId: number,
  action: PostWizardStepInput = null,
  draftId: number | null = null,
  controlMessageId: number | null = null,
): number {
  const parsedStep = resolvePostWizardStep(action);
  if (action !== null && !parsedStep) throw new Error(`Unknown post admin action: ${action}`);
  const updatedAt = new Date().toISOString();
  const expiresAt = parsedStep ? new Date(Date.now() + CONVERSATION_SESSION_TTL_MS).toISOString() : null;
  return saveConversationSession(backendDb, {
    actorId,
    kind: "post",
    draftId,
    action: null,
    step: parsedStep ? postStepName(parsedStep) : null,
    selectedTargets: [],
    data: parsedStep ? postStepData(parsedStep) : {},
    controlMessageId,
    active: parsedStep ? 1 : 0,
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
  const step = resolvePostWizardStep(action);
  if (!step) return false;
  return clearConversationSessionIfCurrent(backendDb, {
    actorId,
    kind: "post",
    step: postStepName(step),
    draftId,
    expectedRevision,
    updatedAt: new Date().toISOString(),
  });
}

export function startPostDialog(backendDb: BackendDb, actorId: number): number {
  return setPostAdminState(backendDb, actorId, "new_post");
}

function retirePostAdminState(backendDb: BackendDb, actorId: number): void {
  retireConversationSession(backendDb, actorId, "post");
}

export function requireCurrentPostSession(backendDb: BackendDb, actorId: number, expectedRevision: number | null): PostAdminState {
  const state = getPostAdminState(backendDb, actorId);
  requireSessionRevision(state?.revision, expectedRevision);
  if (!state) throw new StudioError("action.session-stale");
  return state;
}
